import assert from "node:assert/strict";
import test from "node:test";
import { runCouncil } from "../src/council.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { renderReport } from "../src/report.ts";
import { usageSummary } from "../src/usage.ts";
import { comparison, deferred, models, opinion, registryMock, response } from "./helpers.ts";

const run = (registry: ReturnType<typeof registryMock>["registry"]) => runCouncil({ question: "Q", snapshot: "S", config: DEFAULT_CONFIG, registry, signal: new AbortController().signal });

test("usage totals retain input, output, cached tokens, costs, and parallel wall time", async t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const first = deferred<ReturnType<typeof response>>(), second = deferred<ReturnType<typeof response>>(), synthesis = deferred<ReturnType<typeof response>>();
  const { registry } = registryMock(async (_c, i) => i === 0 ? first.promise : i === 1 ? second.promise : synthesis.promise);
  const pending = run(registry);
  const reply = response(JSON.stringify(opinion));
  reply.usage = { ...reply.usage, cacheRead: 5, totalTokens: 25, cost: { ...reply.usage.cost, total: 0.1234 } };
  now = 100;
  first.resolve(reply);
  await new Promise(resolve => setImmediate(resolve));
  now = 250;
  second.resolve(response(JSON.stringify(opinion)));
  await new Promise(resolve => setImmediate(resolve));
  now = 350;
  synthesis.resolve(response(JSON.stringify(comparison)));
  const result = await pending;
  assert.deepEqual(result.members.map(m => m.durationMs), [100, 250]);
  assert.equal(result.synthesisDurationMs, 100);
  assert.equal(result.durationMs, 350);
  const { rows, partial } = usageSummary(result);
  assert.equal(partial, false);
  assert.deepEqual(rows.at(-1), { call: "Total", tokens: "30 / 30 / 65", cost: "$0.1234", duration: "0.3s" });
  assert.equal(rows[1].cost, "$0.0000");
});

test("invalid, truncated, tool-call, and provider-error outputs retain returned usage", async () => {
  for (const failure of ["json", "length", "error", "toolCall"] as const) {
    const { registry } = registryMock(async (_c, i) => {
      const r = response(JSON.stringify(i < 2 ? opinion : comparison));
      if (i === 0) {
        if (failure === "json") r.content = [{ type: "text", text: "broken" }];
        else if (failure === "toolCall") r.content = [{ type: "toolCall", id: "bad", name: "read", arguments: {} }];
        else r.stopReason = failure;
      }
      return r;
    });
    const result = await run(registry);
    assert.ok(result.members[0].error);
    assert.equal(result.members[0].usage?.totalTokens, 20);
    assert.ok(result.members[0].durationMs! >= 0);
    assert.equal(usageSummary(result).partial, false);
    assert.equal(usageSummary(result).rows.length, 3, "skipped comparison has no row");
  }
});

test("failed synthesis retains its usage and duration", async () => {
  const { registry } = registryMock(async (_c, i) => response(i === 2 ? "broken" : JSON.stringify(opinion)));
  const result = await run(registry);
  assert.ok(result.synthesisError);
  assert.equal(result.synthesisUsage?.totalTokens, 20);
  assert.ok(result.synthesisDurationMs! >= 0);
  assert.equal(usageSummary(result).rows.at(-2)?.call, "Comparison");
});

test("timeouts and thrown stream failures have missing usage, durations, and partial totals", async () => {
  const { registry } = registryMock(async (_c, i) => {
    if (i === 0) throw new Error("Offline");
    return new Promise(() => {});
  });
  const result = await runCouncil({ question: "Q", snapshot: "S", config: { ...DEFAULT_CONFIG, timeoutMs: 10 }, registry, signal: new AbortController().signal });
  assert.ok(result.members.every(m => m.durationMs! >= 0 && !m.usage));
  const summary = usageSummary(result);
  assert.equal(summary.partial, true);
  assert.equal(summary.rows[0].tokens, "— / — / —");
  assert.equal(summary.rows.at(-1)?.cost, "—");
});

test("unresolved members, legacy reports, invalid numbers, and partial accounting", async () => {
  const { registry } = registryMock(undefined, [models[0]]);
  const result = await run(registry);
  const summary = usageSummary(result);
  assert.equal(summary.rows[1].tokens, "Not called");
  assert.equal(summary.rows[1].duration, "—");
  assert.equal(summary.partial, false, "unattempted calls do not make known totals partial");
  assert.doesNotThrow(() => renderReport({ question: "Q", members: [{ member: DEFAULT_CONFIG.members[0], opinion: { ...opinion, confidence: "medium" } }] }));
  result.members[1].model = { provider: "p", id: "m" };
  result.members[0].usage!.cost.total = NaN;
  result.members[0].usage!.input = -1;
  const partial = usageSummary(result);
  assert.equal(partial.partial, true);
  assert.equal(partial.rows.at(-1)?.call, "Total (partial)");
  assert.equal(partial.rows.at(-1)?.tokens, "— / 10 / 20");
  assert.equal(partial.rows.at(-1)?.cost, "—");
  result.members[0].member = { ...result.members[0].member, label: "forged|row\n### Heading\u001b[31m" };
  assert.doesNotMatch(renderReport(result), /\n### Heading|forged\|row|\u001b/);
});
