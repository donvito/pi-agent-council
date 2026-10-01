import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type { CouncilRegistry } from "../src/council.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { ADVISOR_PROMPT } from "../src/opinions.ts";

// Keep explicitly two-advisor scenarios independent of the shipped defaults.
export const TWO_MEMBER_CONFIG = { ...DEFAULT_CONFIG, members: DEFAULT_CONFIG.members.slice(0, 2) };

export const models = DEFAULT_CONFIG.members.map((m, i) => ({
  id: m.model, name: m.label, provider: `provider-${i}`, api: "openai-completions",
  baseUrl: "https://example.invalid", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
})) as Model<Api>[];
export const opinion = {
  recommendation: "Use Postgres", reasoning: ["Existing infrastructure"], risks: ["Throughput may be insufficient"],
  assumptions: ["Moderate throughput"], alternative: "Redis if measurements justify it", confidence: "medium",
};
export const comparison = { agreement: ["Both prefer Postgres for present scale"], disagreement: [], keyAssumptions: ["Moderate throughput"], decisionChangingEvidence: ["Measure sustained throughput"] };
export function response(text: string, model = models[0]): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id,
    stopReason: "stop", timestamp: Date.now(), usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
export interface Call { model: Model<Api>; context: Context; options?: ModelsSimpleStreamOptions }
export function registryMock(handler?: (call: Call, index: number) => Promise<AssistantMessage>, catalog = models) {
  const calls: Call[] = [];
  const registry: CouncilRegistry = {
    getAll: () => catalog,
    hasConfiguredAuth: () => true,
    streamSimple: (model, context, options) => {
      const call = { model, context, options };
      const index = calls.push(call) - 1;
      return { result: () => handler ? handler(call, index) : Promise.resolve(response(JSON.stringify(context.systemPrompt === ADVISOR_PROMPT ? opinion : comparison), model)) } as AssistantMessageEventStream;
    },
  };
  return { registry, calls };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
