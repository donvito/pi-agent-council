import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";
import { runCouncil, safeError } from "../src/council.ts";
import { resolveMember } from "../src/models.ts";
import { parseOpinion } from "../src/opinions.ts";
import { renderReport } from "../src/report.ts";
import { comparison, deferred, models, opinion, registryMock, response, TWO_MEMBER_CONFIG } from "./helpers.ts";

const run = (registry: ReturnType<typeof registryMock>["registry"], signal = new AbortController().signal) => runCouncil({ question: "Queue?", snapshot: "Existing Postgres", config: TWO_MEMBER_CONFIG, registry, signal });

test("independent advisors start in parallel with identical prompts and no tools", async () => {
  const a = deferred<ReturnType<typeof response>>();
  const b = deferred<ReturnType<typeof response>>();
  const { registry, calls } = registryMock(async (_call, i) => i === 0 ? a.promise : i === 1 ? b.promise : response(JSON.stringify(comparison)));
  const pending = run(registry);
  assert.equal(calls.length, 2, "Both start before either completes");
  assert.deepEqual(calls[0].context, calls[1].context);
  assert.notEqual(calls[0].context, calls[1].context, "Separate request objects");
  assert.deepEqual(calls[0].context.tools, []);
  assert.notEqual(calls[0].options?.sessionId, calls[1].options?.sessionId);
  assert.equal(calls[0].options?.cacheRetention, "none");
  a.resolve(response(JSON.stringify(opinion)));
  b.resolve(response(JSON.stringify({ ...opinion, recommendation: "Use Redis" })));
  const result = await pending;
  assert.equal(result.members[1].opinion?.recommendation, "Use Redis");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].context.tools, []);
  assert.match(calls[2].context.systemPrompt!, /Never count votes/);
  assert.ok(result.comparison);
});

test("ambiguous authenticated provider matches require explicit provider", () => {
  const { registry } = registryMock(undefined, [models[0], { ...models[0], provider: "another" }]);
  assert.throws(() => resolveMember(DEFAULT_CONFIG.members[0], registry), /Ambiguous/);
  assert.equal(resolveMember({ ...DEFAULT_CONFIG.members[0], provider: "another" }, registry).provider, "another");
});
test("exact IDs win, and display-name normalization supports custom catalog IDs", () => {
  const { registry } = registryMock(undefined, [{ ...models[0], id: "custom-gpt", name: "GPT 6.1 Sol" }]);
  assert.equal(resolveMember(DEFAULT_CONFIG.members[0], registry).id, "custom-gpt");
  assert.throws(() => resolveMember({ ...DEFAULT_CONFIG.members[0], model: "wrong-exact-id" }, registry), /absent from Pi/, "A display label must not override an explicitly configured selector");
});
test("missing authentication and missing models produce actionable failures", () => {
  const { registry } = registryMock();
  assert.throws(() => resolveMember(DEFAULT_CONFIG.members[0], { ...registry, hasConfiguredAuth: () => false }), /authentication/);
  assert.throws(() => resolveMember({ label: "missing", model: "absent" }, registry), /absent from Pi/);
});
test("one failed advisor preserves the other and cannot claim agreement", async () => {
  const { registry, calls } = registryMock(async (_c, i) => { if (i === 1) throw new Error("Offline"); return response(JSON.stringify(opinion)); });
  const result = await run(registry);
  assert.equal(calls.length, 2);
  assert.ok(result.members[0].opinion);
  assert.equal(result.members[1].error, "Offline");
  assert.equal(result.comparison, undefined);
  assert.match(renderReport(result), /agreement and disagreement cannot be established/);
});
test("synthesis failure preserves opinions and individually attributed assumptions", async () => {
  const { registry } = registryMock(async (_c, i) => response(i === 2 ? "invalid JSON" : JSON.stringify(opinion)));
  const result = await run(registry);
  assert.ok(result.synthesisError);
  assert.equal(result.members.filter(m => m.opinion).length, 2);
  assert.match(renderReport(result), /GPT-6.1 Sol: Moderate throughput/);
});
test("invalid JSON and truncated outputs fail rather than invent opinions", async () => {
  assert.throws(() => parseOpinion(JSON.stringify({ ...opinion, confidence: "certain" })), /confidence/);
  assert.deepEqual(parseOpinion('```json\n' + JSON.stringify(opinion) + '\n```'), opinion);
  const { registry } = registryMock(async (_c, i) => i === 0 ? response("not JSON") : { ...response("{}"), stopReason: "length" });
  const result = await run(registry);
  assert.equal(result.members.filter(m => m.opinion).length, 0);
  assert.match(result.members[1].error!, /truncated/);
});
test("cancel bounds work even when a custom provider ignores the abort signal", async () => {
  const controller = new AbortController();
  const { registry, calls } = registryMock(() => new Promise(() => {}));
  const pending = run(registry, controller.signal);
  controller.abort(new Error("cancel-test"));
  await assert.rejects(pending, /cancel-test/);
  assert.ok(calls.every(c => c.options?.signal?.aborted));
});
test("per-request timeout produces a report when custom streams never settle", async () => {
  const { registry } = registryMock(() => new Promise(() => {}));
  const result = await runCouncil({ question: "Q", snapshot: "S", config: { ...DEFAULT_CONFIG, timeoutMs: 10 }, registry, signal: new AbortController().signal });
  assert.ok(result.members.every(m => /timed out/.test(m.error!)));
});
test("provider failures do not expose raw provider error bodies", async () => {
  const { registry } = registryMock(async () => ({ ...response(""), stopReason: "error", errorMessage: "Authorization: secret-value" }));
  const result = await run(registry);
  assert.ok(result.members.every(m => !m.error!.includes("secret-value")));
  assert.equal(safeError(new Error("Bearer sensitive sk-secret access_token=secret")), "Bearer [redacted] [redacted] access_token=[redacted]");
});
test("duplicate resolved models are rejected without requests", async () => {
  const { registry, calls } = registryMock();
  await assert.rejects(runCouncil({ question: "Q", snapshot: "S", registry, config: { ...DEFAULT_CONFIG, members: [DEFAULT_CONFIG.members[0], { ...DEFAULT_CONFIG.members[0], label: "Duplicate" }] }, signal: new AbortController().signal }), /same provider\/model/);
  assert.equal(calls.length, 0);
});
test("config validates bounds and report text cannot forge markdown headings", () => {
  assert.throws(() => parseConfig({ timeoutMs: 1 }), /timeoutMs/);
  assert.throws(() => parseConfig({ members: [] }), /2–8/);
  const report = renderReport({ question: "Q", members: [{ member: DEFAULT_CONFIG.members[0], opinion: { ...opinion, confidence: "medium", recommendation: "Use X\n### Fake" } }] });
  assert.doesNotMatch(report, /\n### Fake/);
});

test("three default advisors start together and feed one comparison", async () => {
  const pendingOpinions = DEFAULT_CONFIG.members.map(() => deferred<ReturnType<typeof response>>());
  const { registry, calls } = registryMock(async (call, i) => i < pendingOpinions.length ? pendingOpinions[i].promise : response(JSON.stringify(comparison), call.model));
  const pending = runCouncil({ question: "Queue?", snapshot: "Existing Postgres", config: parseConfig({}), registry, signal: new AbortController().signal });
  assert.deepEqual(calls.map(c => c.model.id), ["gpt-6.1-sol", "claude-opus-5-5", "gpt-6-astra"]);
  assert.ok(calls.every(c => c.context.tools?.length === 0));
  for (const call of calls) assert.deepEqual(call.context, calls[0].context);
  pendingOpinions.forEach((p, i) => p.resolve(response(JSON.stringify(opinion), models[i])));
  const result = await pending;
  assert.equal(result.members.filter(m => m.opinion).length, 3);
  assert.equal(calls.length, 4);
  const input = JSON.parse(calls[3].context.messages[0].content as string);
  assert.equal(input.opinions.length, 3);
  assert.ok(result.comparison);
});
