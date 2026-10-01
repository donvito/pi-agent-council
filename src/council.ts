import { randomUUID } from "node:crypto";
import type { Api, Context, Model, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { CouncilConfig, MemberConfig } from "./config.ts";
import { resolveMember } from "./models.ts";
import { ADVISOR_PROMPT, COMPARISON_PROMPT, parseComparison, parseOpinion, type Comparison, type Opinion } from "./opinions.ts";

export interface MemberResult {
  member: MemberConfig;
  model?: { provider: string; id: string };
  opinion?: Opinion;
  error?: string;
  usage?: Usage;
}
export interface CouncilResult {
  question: string;
  members: MemberResult[];
  comparison?: Comparison;
  synthesisError?: string;
  synthesisUsage?: Usage;
  synthesizer?: { provider: string; id: string };
}
export type CouncilRegistry = Pick<ModelRegistry, "getAll" | "hasConfiguredAuth" | "streamSimple">;

export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Request failed.";
  return message
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-|sk_)[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
}

async function request(registry: CouncilRegistry, model: Model<Api>, context: Context, config: CouncilConfig, parent: AbortSignal) {
  parent.throwIfAborted();
  const controller = new AbortController();
  const forward = () => controller.abort(parent.reason);
  parent.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`Council request timed out after ${config.timeoutMs / 1000}s.`)), config.timeoutMs);
  let abortListener: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(controller.signal.reason ?? new Error("Council cancelled."));
      controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    // A fresh session ID prevents provider-side conversation state leaking across advisors.
    const response = await Promise.race([
      registry.streamSimple(model, structuredClone(context), {
        signal: controller.signal,
        maxTokens: config.maxOutputTokens,
        reasoning: "low",
        cacheRetention: "none",
        sessionId: randomUUID(),
      }).result(),
      aborted,
    ]);
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      // Provider error bodies can contain headers/credentials. Keep UI diagnostics generic.
      throw new Error(`Provider request ${response.stopReason} for ${model.provider}/${model.id}. Check Pi authentication, quota, and connectivity.`);
    }
    if (response.stopReason === "length") throw new Error("Model output was truncated. Increase maxOutputTokens in council.json.");
    if (response.content.some(c => c.type === "toolCall")) throw new Error("Advisor attempted a tool call; no tools are available to the council.");
    const text = response.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    return { text, usage: response.usage };
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", forward);
    if (abortListener) controller.signal.removeEventListener("abort", abortListener);
  }
}

export async function runCouncil(options: {
  question: string;
  snapshot: string;
  config: CouncilConfig;
  registry: CouncilRegistry;
  currentModel?: Model<Api>;
  signal: AbortSignal;
  progress?: (label: string, state: "running" | "done" | "error", error?: string) => void;
}): Promise<CouncilResult> {
  const { question, snapshot, config, registry, signal, progress } = options;
  const context: Context = {
    systemPrompt: ADVISOR_PROMPT,
    messages: [{ role: "user", content: JSON.stringify({ question, sessionSnapshot: snapshot }), timestamp: Date.now() }],
    tools: [],
  };
  const resolved = config.members.map(member => {
    try { return { member, model: resolveMember(member, registry), error: undefined }; }
    catch (error) { return { member, model: undefined, error: safeError(error) }; }
  });
  const identities = resolved.filter(r => r.model).map(r => `${r.model!.provider}/${r.model!.id}`);
  if (new Set(identities).size !== identities.length) throw new Error("Council members resolve to the same provider/model. Configure distinct models for independent opinions.");

  const members = await Promise.all(resolved.map(async ({ member, model, error }): Promise<MemberResult> => {
    if (!model) {
      progress?.(member.label, "error", error);
      return { member, error };
    }
    const identity = { provider: model.provider, id: model.id };
    progress?.(member.label, "running");
    try {
      const response = await request(registry, model, context, config, signal);
      const opinion = parseOpinion(response.text);
      progress?.(member.label, "done");
      return { member, model: identity, opinion, usage: response.usage };
    } catch (e) {
      const error = safeError(e);
      progress?.(member.label, "error", error);
      return { member, model: identity, error };
    }
  }));
  signal.throwIfAborted();
  const result: CouncilResult = { question, members };
  const successful = members.filter(m => m.opinion);
  if (successful.length < 2) return result;

  const firstSuccess = resolved.find(r => r.model && successful.some(s => s.model?.provider === r.model!.provider && s.model.id === r.model!.id))?.model;
  const synthesizer = options.currentModel && registry.hasConfiguredAuth(options.currentModel) ? options.currentModel : firstSuccess;
  if (!synthesizer) return result;
  result.synthesizer = { provider: synthesizer.provider, id: synthesizer.id };
  progress?.("Comparison", "running");
  try {
    const response = await request(registry, synthesizer, {
      systemPrompt: COMPARISON_PROMPT,
      messages: [{ role: "user", content: JSON.stringify({ question, opinions: successful.map(m => ({ member: m.member.label, opinion: m.opinion })) }), timestamp: Date.now() }],
      tools: [],
    }, config, signal);
    result.comparison = parseComparison(response.text);
    result.synthesisUsage = response.usage;
    progress?.("Comparison", "done");
  } catch (e) {
    result.synthesisError = safeError(e);
    progress?.("Comparison", "error", result.synthesisError);
  }
  signal.throwIfAborted();
  return result;
}
