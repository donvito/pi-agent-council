import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { CouncilResult } from "../src/council.ts";
import { CouncilView, latestCouncilReport } from "../src/view.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { opinion } from "./helpers.ts";

function result(count = 2): CouncilResult {
  return { question: "Choose a database?", members: Array.from({ length: count }, (_, i) => ({ member: { ...DEFAULT_CONFIG.members[i % 2], label: `Advisor ${i + 1}` }, model: { provider: "test", id: `model-${i}` }, opinion: { ...opinion, confidence: "medium" } })) };
}
const plainTheme = { fg: (_color: string, s: string) => s } as Pick<Theme, "fg">;

function viewer(r?: CouncilResult, height = 2000) {
  let renders = 0, closed = 0;
  const view = new CouncilView({ text: "Legacy report\nRecommendation: Keep it", result: r }, plainTheme, () => height, () => renders++, () => closed++);
  return { view, renders: () => renders, closed: () => closed };
}

test("wide layout aligns matching sections, narrow layout stacks advisor pairs", () => {
  const r = result();
  r.members[0].opinion!.reasoning = ["長い文 🌏 ".repeat(80)];
  const { view } = viewer(r);
  const wide = view.render(120);
  assert.ok(wide.some(s => /Advisor 1\s+│ Advisor 2/.test(s)));
  assert.ok(wide.some(s => /Risks\s+│ Risks/.test(s)), "sections realign after unequal content");
  assert.ok(wide.every(s => visibleWidth(s) <= 120));
  const narrow = view.render(60);
  assert.ok(narrow.findIndex(s => s.includes("Advisor 1")) < narrow.findIndex(s => s.includes("Advisor 2")));
  assert.ok(narrow.every(s => visibleWidth(s) <= 60));
  for (const width of [1, 8, 80, 99, 100, 101]) assert.ok(view.render(width).every(s => visibleWidth(s) <= width));
});

test("pair navigation supports 2–8 members and clamps at boundaries", () => {
  for (let count = 2; count <= 8; count++) {
    const h = viewer(result(count));
    h.view.render(120);
    h.view.handleInput("\u001b[D");
    assert.match(h.view.render(120)[0], /pair 1\//);
    for (let page = 1; page < Math.ceil(count / 2); page++) {
      h.view.handleInput("\u001b[C");
      assert.match(h.view.render(120).join("\n"), new RegExp(`Advisor ${page * 2 + 1}`));
    }
    h.view.handleInput("\u001b[C");
    assert.match(h.view.render(120)[0], new RegExp(`pair ${Math.ceil(count / 2)}/${Math.ceil(count / 2)}`));
    h.view.handleInput("\u001b");
    assert.equal(h.closed(), 1);
  }
});

test("shared scrolling, resize clamping, navigation keys, and theme invalidation", () => {
  const r = result(4);
  r.members[0].opinion!.reasoning = ["long evidence ".repeat(100)];
  let color = "\u001b[31m", height = 12;
  let renders = 0;
  const view = new CouncilView({ text: "", result: r }, { fg: (_c, s) => `${color}${s}` } as Pick<Theme, "fg">, () => height, () => renders++, () => {});
  const start = view.render(120).join("\n");
  view.handleInput("\u001b[B");
  assert.notEqual(view.render(120).join("\n"), start);
  view.handleInput("\u001b[A");
  assert.equal(view.render(120).join("\n"), start);
  view.handleInput("\u001b[6~");
  assert.notEqual(view.render(120).join("\n"), start);
  view.handleInput("\u001b[5~");
  assert.equal(view.render(120).join("\n"), start);
  view.handleInput("\u001b[F");
  assert.match(view.render(120).join("\n"), /Total|duration|majority/);
  view.handleInput("\u001b[H");
  assert.equal(view.render(120).join("\n"), start);
  color = "\u001b[32m";
  view.invalidate();
  assert.ok(view.render(120).some(s => s.includes("\u001b[32mQuestion")));
  height = 2000;
  assert.ok(view.render(40).every(s => visibleWidth(s) <= 40));
  assert.ok(renders >= 6);
});

test("failed members and synthesis remain visible; escape sequences are stripped", () => {
  const r = result();
  r.members[1].opinion = undefined;
  r.members[1].error = "Offline\u001b[31m\u001b]0;evil\u0007";
  r.synthesisError = "No comparison";
  const output = viewer(r).view.render(120).join("\n");
  assert.match(output, /Unavailable: Offline/);
  assert.match(output, /No comparison/);
  assert.match(output, /Key assumptions/);
  assert.match(output, /Usage/);
  assert.doesNotMatch(output, /\u001b|evil/);
});

test("latest report comes from saved branch entries and falls back to legacy text", () => {
  const session = SessionManager.inMemory("/tmp");
  const root = session.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
  session.appendCustomMessageEntry("agent-council-report", "first", true, result());
  assert.equal(latestCouncilReport(session.getBranch())?.text, "first");
  assert.equal(latestCouncilReport(session.getBranch())?.result?.members.length, 2);
  session.appendCustomMessageEntry("agent-council-report", "newer", true);
  const legacy = latestCouncilReport(session.getBranch())!;
  assert.equal(legacy.text, "newer");
  assert.equal(legacy.result, undefined);
  const h = viewer();
  assert.match(h.view.render(60).join("\n"), /Legacy report/);
  session.branch(root);
  assert.equal(latestCouncilReport(session.getBranch()), undefined);
  session.appendCustomMessageEntry("agent-council-report", "malformed", true, { question: "Q", members: [{ member: { label: "oops" } }] });
  assert.equal(latestCouncilReport(session.getBranch())?.result, undefined);
});
