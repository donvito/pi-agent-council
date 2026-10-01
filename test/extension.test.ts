import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager, SessionManager, type ExtensionAPI, type ExtensionCommandContext, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { loadConfig, DEFAULT_CONFIG } from "../src/config.ts";
import { snapshotContext } from "../src/context.ts";
import { registryMock } from "./helpers.ts";
import { comparison, opinion, response } from "./helpers.ts";
import { renderReport } from "../src/report.ts";
import { CouncilView } from "../src/view.ts";
import type { TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

test("loads TypeScript through Pi's real extension loader and discovers the skill", async () => {
  const dir = await mkdtemp(join(tmpdir(), "council-loader-"));
  try {
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory(), additionalExtensionPaths: [resolve("index.ts")], additionalSkillPaths: [resolve("skills")], noContextFiles: true });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const council = loader.getExtensions().extensions.find(e => e.path === resolve("index.ts"));
    assert.ok(council);
    assert.ok(council.commands.has("council"));
    assert.ok(council.commands.has("council-cancel"));
    assert.ok(council.commands.has("council-view"));
    assert.equal(council.tools.size, 0);
    assert.equal(loader.getSkills().skills.find(s => s.name === "council")?.disableModelInvocation, true);
    assert.deepEqual(loader.getSkills().diagnostics, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("configuration precedence respects project trust and explicit paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "council-config-"));
  try {
    await mkdir(join(dir, ".pi"));
    await writeFile(join(dir, "council.json"), JSON.stringify({ maxContextChars: 2000 }));
    await writeFile(join(dir, ".pi/council.json"), JSON.stringify({ maxContextChars: 3000 }));
    assert.equal((await loadConfig(dir, dir, false)).maxContextChars, 2000);
    assert.equal((await loadConfig(dir, dir, true)).maxContextChars, 3000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function harness(dir: string) {
  const commands = new Map<string, RegisteredCommand>();
  const events = new Map<string, () => void>();
  const sent: { message: Parameters<ExtensionAPI["sendMessage"]>[0]; options: Parameters<ExtensionAPI["sendMessage"]>[1] }[] = [];
  const notifications: string[] = [];
  const { registry, calls } = registryMock();
  const session = SessionManager.inMemory(dir);
  session.appendMessage({ role: "user", content: "Existing Postgres", timestamp: Date.now() });
  const pi = { registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command), on: (event: string, handler: () => void) => events.set(event, handler), sendMessage: (message: Parameters<ExtensionAPI["sendMessage"]>[0], options: Parameters<ExtensionAPI["sendMessage"]>[1]) => { sent.push({ message, options }); } } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, mode: "print", hasUI: true, ui: { notify: (s: string) => notifications.push(s), setStatus: () => {} }, isIdle: () => true, isProjectTrusted: () => true, sessionManager: session, modelRegistry: registry } as unknown as ExtensionCommandContext;
  extension(pi);
  return { commands, events, sent, notifications, ctx, calls, session };
}

test("command injects a visible report into session context without starting a turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "council-command-"));
  const previous = process.env.PI_COUNCIL_CONFIG;
  try {
    process.env.PI_COUNCIL_CONFIG = join(dir, "config.json");
    await writeFile(process.env.PI_COUNCIL_CONFIG, JSON.stringify(DEFAULT_CONFIG));
    const h = harness(dir);
    await h.commands.get("council")!.handler("Queue?", h.ctx);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].message.display, true);
    assert.equal(h.sent[0].options?.triggerTurn, false);
    assert.equal(h.sent[0].options?.deliverAs, undefined, "nextTurn would hide and postpone the report");
    const m = h.sent[0].message;
    h.session.appendCustomMessageEntry(m.customType, m.content, m.display, m.details);
    assert.match(snapshotContext(h.session.getBranch(), 48000), /Agent Council/);
    assert.match(snapshotContext(h.session.getBranch(), 48000), /Reported cost \(USD\)/);
    assert.ok((m.details as { durationMs: number }).durationMs >= 0);
    assert.equal(h.calls.length, 3);
    assert.match(h.notifications.join("\n"), /GPT-6.1 Sol: complete/);
  } finally {
    if (previous === undefined) delete process.env.PI_COUNCIL_CONFIG; else process.env.PI_COUNCIL_CONFIG = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("empty command, cancellation while waiting, and concurrent command guard", async () => {
  const h = harness(tmpdir());
  await h.commands.get("council")!.handler("", h.ctx);
  assert.match(h.notifications.pop()!, /Usage/);
  h.ctx.isIdle = () => false;
  h.ctx.waitForIdle = () => new Promise(() => {});
  const pending = h.commands.get("council")!.handler("Question", h.ctx);
  await h.commands.get("council")!.handler("Second", h.ctx);
  assert.match(h.notifications.pop()!, /already running/);
  await h.commands.get("council-cancel")!.handler("", h.ctx);
  await pending;
  assert.equal(h.sent.length, 0);
  assert.equal(h.calls.length, 0);
});

test("snapshot is bounded, excludes thinking/system instructions, and retains tool text", () => {
  const session = SessionManager.inMemory(tmpdir());
  session.appendMessage({ role: "system", content: "SECRET SYSTEM", timestamp: Date.now() });
  session.appendMessage({ role: "user", content: "x".repeat(2000), timestamp: Date.now() });
  session.appendMessage({ role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text: "Relevant source" }], isError: false, timestamp: Date.now() });
  const snapshot = snapshotContext(session.getBranch(), 1000);
  assert.equal(snapshot.length, 1000);
  assert.match(snapshot, /Earlier context omitted/);
  assert.match(snapshot, /Relevant source/);
  assert.doesNotMatch(snapshot, /SECRET SYSTEM/);
});

test("viewer uses persisted branch data, makes no model calls, and closes on session replacement", async () => {
  const h = harness("/tmp");
  const r = { question: "Q", members: DEFAULT_CONFIG.members.map(member => ({ member, opinion: { ...opinion, confidence: "medium" as const }, usage: response("").usage })), comparison };
  h.session.appendCustomMessageEntry("agent-council-report", renderReport(r), true, r);
  h.ctx.mode = "tui";
  let view: CouncilView | undefined;
  h.ctx.ui.custom = async (factory, options) => new Promise(resolve => {
    assert.equal(options?.overlay, true);
    const tui = { terminal: { rows: 30 }, requestRender: () => {} } as unknown as TUI;
    const theme = { fg: (_color: string, s: string) => s } as Theme;
    const component = factory(tui, theme, {} as never, resolve);
    assert.ok(component instanceof CouncilView);
    view = component;
    assert.match(view.render(120).join("\n"), /GPT-6.1 Sol.*Claude Opus 5.5/);
  });
  const pending = h.commands.get("council-view")!.handler("", h.ctx);
  assert.ok(view);
  h.events.get("session_start")!();
  await pending;
  assert.equal(h.calls.length, 0);
  const reopened = h.commands.get("council-view")!.handler("", h.ctx);
  view!.handleInput("\u001b");
  await reopened;
  assert.equal(h.calls.length, 0);
  h.ctx.mode = "print";
  await h.commands.get("council-view")!.handler("", h.ctx);
  assert.match(h.notifications.at(-1)!, /requires interactive Pi/);
});

test("viewer reports an empty branch without opening an overlay", async () => {
  const h = harness("/tmp");
  await h.commands.get("council-view")!.handler("", h.ctx);
  assert.match(h.notifications.at(-1)!, /No council report on this branch/);
  assert.equal(h.calls.length, 0);
});
