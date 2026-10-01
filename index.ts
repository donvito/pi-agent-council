import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config.ts";
import { snapshotContext } from "./src/context.ts";
import { runCouncil, safeError } from "./src/council.ts";
import { renderReport } from "./src/report.ts";
import { CouncilView, latestCouncilReport } from "./src/view.ts";

export default function councilExtension(pi: ExtensionAPI) {
  let active: AbortController | undefined;
  let closeView: (() => void) | undefined;
  const notify = (ctx: ExtensionContext, text: string, type: "info" | "warning" | "error" = "info") => {
    if (ctx.hasUI) ctx.ui.notify(text, type);
  };
  const cancel = () => { active?.abort(new Error("Council cancelled.")); closeView?.(); };
  pi.on("session_shutdown", cancel);
  pi.on("session_tree", cancel);
  pi.on("session_start", cancel);

  pi.registerCommand("council-view", {
    description: "View the latest council report side by side",
    handler: async (_args, ctx) => {
      const report = latestCouncilReport(ctx.sessionManager.getBranch());
      if (!report) { notify(ctx, "No council report on this branch. Run /council <question> first.", "warning"); return; }
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        if (ctx.hasUI) notify(ctx, "Council viewer requires interactive Pi; the report is in the transcript.");
        else console.log("Council viewer requires interactive Pi; the report is in the transcript.");
        return;
      }
      closeView?.();
      let close: (() => void) | undefined;
      try {
        await ctx.ui.custom<void>((tui, theme, _keys, done) => {
          close = () => done();
          closeView = close;
          return new CouncilView(report, theme, () => Math.max(3, Math.floor(tui.terminal.rows * 0.8)), () => tui.requestRender(), close);
        }, { overlay: true, overlayOptions: { width: "95%", maxHeight: "80%", anchor: "center" } });
      } finally { if (closeView === close) closeView = undefined; }
    },
  });

  pi.registerCommand("council-cancel", {
    description: "Cancel the running council requests",
    handler: async (_args, ctx) => {
      if (active) { cancel(); notify(ctx, "Cancelling council…"); }
      else notify(ctx, "No council is running.");
    },
  });
  pi.registerCommand("council", {
    description: "Get independent read-only advice: /council <question>",
    handler: async (args, ctx) => {
      const question = args.trim();
      if (!question) { notify(ctx, "Usage: /council <question>", "warning"); return; }
      if (question.length > 8000) { notify(ctx, "Keep the council question under 8000 characters.", "warning"); return; }
      if (active) { notify(ctx, "Council already running. Use /council-cancel to stop it.", "warning"); return; }
      if (typeof ctx.modelRegistry.streamSimple !== "function") {
        notify(ctx, "pi-agent-council requires Pi 0.99.2 or a compatible modelRegistry.streamSimple API.", "error"); return;
      }
      const controller = new AbortController();
      active = controller;
      const sessionId = ctx.sessionManager.getSessionId();
      const states = new Map<string, string>();
      const progress = (label: string, state: "running" | "done" | "error", error?: string) => {
        if (controller.signal.aborted) return;
        states.set(label, state);
        if (ctx.mode === "tui") ctx.ui.setStatus("agent-council", [...states].map(([label, state]) => `${label}: ${state}`).join(" | "));
        if (state === "error") notify(ctx, `${label}: ${error}`, "warning");
        else notify(ctx, `${label}: ${state === "running" ? "consulting…" : "complete"}`);
      };
      try {
        if (!ctx.isIdle()) {
          notify(ctx, "Council is waiting for the current Pi turn to finish…");
          let onAbort: (() => void) | undefined;
          try {
            await Promise.race([ctx.waitForIdle(), new Promise<never>((_, reject) => {
              onAbort = () => reject(controller.signal.reason);
              controller.signal.addEventListener("abort", onAbort, { once: true });
            })]);
          } finally {
            if (onAbort) controller.signal.removeEventListener("abort", onAbort);
          }
        }
        controller.signal.throwIfAborted();
        const config = await loadConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted());
        const snapshot = snapshotContext(ctx.sessionManager.getBranch(), config.maxContextChars);
        notify(ctx, `Consulting ${config.members.length} read-only advisors in parallel…`);
        const result = await runCouncil({ question, snapshot, config, registry: ctx.modelRegistry, currentModel: ctx.model, signal: controller.signal, progress });
        controller.signal.throwIfAborted();
        if (ctx.sessionManager.getSessionId() !== sessionId) return;
        pi.sendMessage({
          customType: "agent-council-report",
          content: renderReport(result),
          display: true,
          details: result,
        }, { triggerTurn: false });
        notify(ctx, "Council report added to this session. Your next message can ask Pi to act on it.");
      } catch (error) {
        if (!controller.signal.aborted) notify(ctx, `Council failed: ${safeError(error)}`, "error");
        else notify(ctx, "Council cancelled; no report was added.");
      } finally {
        if (active === controller) {
          active = undefined;
          if (ctx.mode === "tui") ctx.ui.setStatus("agent-council", undefined);
        }
      }
    },
  });
}
