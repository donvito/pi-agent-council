import type { SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { CouncilResult, MemberResult } from "./council.ts";
import { parseOpinion, parseComparison } from "./opinions.ts";
import { usageSummary, USAGE_NOTE } from "./usage.ts";

const clean = (s: string) => stripTerminalSequences(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
const wrap = (s: string, width: number) => wrapTextWithAnsi(clean(s), Math.max(1, width));
const list = (items: string[]) => items.length ? items.map(s => `• ${s}`).join("\n") : "—";

export interface SavedCouncilReport { text: string; result?: CouncilResult }

// Validate the display-bearing fields of persisted data, including legacy reports.
function savedResult(value: unknown): CouncilResult | undefined {
  if (!value || typeof value !== "object") return;
  const r = value as CouncilResult;
  if (typeof r.question !== "string" || !Array.isArray(r.members) || r.members.length < 1 || r.members.length > 8) return;
  try {
    for (const m of r.members) {
      if (!m || typeof m.member?.label !== "string" || typeof m.member.model !== "string") return;
      if (m.model && (typeof m.model.provider !== "string" || typeof m.model.id !== "string")) return;
      if (m.error !== undefined && typeof m.error !== "string") return;
      if (m.opinion) parseOpinion(JSON.stringify(m.opinion));
    }
    if (r.comparison) parseComparison(JSON.stringify(r.comparison));
    if (r.synthesizer && (typeof r.synthesizer.provider !== "string" || typeof r.synthesizer.id !== "string")) return;
    if (r.synthesisError !== undefined && typeof r.synthesisError !== "string") return;
    return r;
  } catch { return; }
}

export function latestCouncilReport(branch: SessionEntry[]): SavedCouncilReport | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "custom_message" || entry.customType !== "agent-council-report") continue;
    const text = typeof entry.content === "string" ? entry.content : entry.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    return { text, result: savedResult(entry.details) };
  }
}

function memberSections(member: MemberResult): [string, string][] {
  const o = member.opinion;
  return [
    [member.member.label, member.model ? `${member.model.provider}/${member.model.id}` : "Not called"],
    ["Recommendation", o?.recommendation ?? `Unavailable: ${member.error ?? "Request failed."}`],
    ["Reasoning", o ? list(o.reasoning) : "—"],
    ["Risks", o ? list(o.risks) : "—"],
    ["Assumptions", o ? list(o.assumptions) : "—"],
    ["Alternative", o?.alternative ?? "—"],
    ["Confidence (self-reported)", o?.confidence ?? "—"],
  ];
}

export class CouncilView implements Component {
  private page = 0;
  private scroll = 0;
  private contentHeight = 0;
  private viewportHeight = 1;
  private cache?: { width: number; page: number; lines: string[] };
  constructor(private report: SavedCouncilReport, private theme: Pick<Theme, "fg"> & Partial<Pick<Theme, "bg">>, private height: () => number, private requestRender: () => void, private done: () => void) {}
  invalidate() { this.cache = undefined; }
  private get pages() { return Math.max(1, Math.ceil((this.report.result?.members.length ?? 0) / 2)); }
  handleInput(data: string) {
    if (matchesKey(data, Key.escape)) { this.done(); return; }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      const next = Math.max(0, Math.min(this.pages - 1, this.page + (matchesKey(data, Key.right) ? 1 : -1)));
      if (next !== this.page) { this.page = next; this.scroll = 0; this.invalidate(); }
    } else if (matchesKey(data, Key.up)) this.scroll--;
    else if (matchesKey(data, Key.down)) this.scroll++;
    else if (matchesKey(data, Key.pageUp)) this.scroll -= this.viewportHeight;
    else if (matchesKey(data, Key.pageDown)) this.scroll += this.viewportHeight;
    else if (matchesKey(data, Key.home)) this.scroll = 0;
    else if (matchesKey(data, Key.end)) this.scroll = this.contentHeight;
    else return;
    this.scroll = Math.max(0, Math.min(Math.max(0, this.contentHeight - this.viewportHeight), this.scroll));
    this.requestRender();
  }
  private heading(text: string, width: number) { return wrap(text, width).map(s => this.theme.fg("accent", s)); }
  private section(title: string, text: string, width: number) {
    // Preserve generated list boundaries while stripping controls from each item.
    return [...this.heading(title, width), ...text.split("\n").flatMap(s => wrap(s, width)), ""];
  }
  private content(width: number): string[] {
    if (this.cache?.width === width && this.cache.page === this.page) return this.cache.lines;
    const r = this.report.result;
    if (!r) return this.report.text.split("\n").flatMap(s => wrap(s, width));
    const lines = this.section("Question", r.question, width);
    const members = r.members.slice(this.page * 2, this.page * 2 + 2);
    if (width >= 100 && members.length === 2) {
      const leftWidth = Math.floor((width - 3) / 2), rightWidth = width - leftWidth - 3;
      const left = memberSections(members[0]), right = memberSections(members[1]);
      for (let i = 0; i < left.length; i++) {
        const a = this.section(left[i][0], left[i][1], leftWidth), b = this.section(right[i][0], right[i][1], rightWidth);
        for (let j = 0; j < Math.max(a.length, b.length); j++) {
          const first = a[j] ?? "";
          lines.push(first + " ".repeat(Math.max(0, leftWidth - visibleWidth(first))) + this.theme.fg("muted", " │ ") + (b[j] ?? ""));
        }
      }
    } else {
      for (const m of members) for (const [title, text] of memberSections(m)) lines.push(...this.section(title, text, width));
    }
    if (r.synthesizer) lines.push(...this.section("Comparison by", `${r.synthesizer.provider}/${r.synthesizer.id}`, width));
    if (!r.comparison) lines.push(...this.section("Comparison unavailable", r.synthesisError ?? "Fewer than two usable opinions; agreement and disagreement cannot be established.", width));
    const c = r.comparison;
    const assumptions = c?.keyAssumptions ?? r.members.flatMap(m => m.opinion?.assumptions.map(a => `${m.member.label}: ${a}`) ?? []);
    for (const [title, items] of [["Agreement", c?.agreement ?? []], ["Disagreement", c?.disagreement ?? []], ["Key assumptions", assumptions], ["Decision-changing evidence", c?.decisionChangingEvidence ?? []]] as [string, string[]][]) {
      lines.push(...this.section(title, list(items), width));
    }
    lines.push(...this.heading("Usage · tokens input / output / total · cost USD", width));
    const rows = usageSummary(r).rows;
    if (width >= 80) {
      const callWidth = width - 57;
      lines.push(`${truncateToWidth("Call", callWidth, "", true)} │ ${truncateToWidth("Tokens", 26, "", true)} │ ${truncateToWidth("Cost", 12, "", true)} │ Duration`);
      for (const row of rows) lines.push(`${truncateToWidth(clean(row.call), callWidth, "…", true)} │ ${truncateToWidth(row.tokens, 26, "…", true)} │ ${truncateToWidth(row.cost, 12, "…", true)} │ ${row.duration}`);
    } else {
      for (const row of rows) lines.push(...wrap(`${row.call}: ${row.tokens} tokens · ${row.cost} · ${row.duration}`, width));
    }
    lines.push("", ...wrap(USAGE_NOTE, width), "", ...wrap("Independent advisory opinions; no majority vote or authorization to edit files.", width));
    // Final width guard covers very large numeric metrics as well as wide Unicode.
    const fitted = lines.map(s => truncateToWidth(s, width, "…"));
    this.cache = { width, page: this.page, lines: fitted };
    return fitted;
  }
  render(width: number): string[] {
    if (width < 1) return [];
    const framed = width >= 5;
    const contentWidth = framed ? width - 4 : width;
    const lines = this.content(contentWidth);
    this.contentHeight = lines.length;
    const availableHeight = Math.max(3, Math.floor(this.height()));
    this.viewportHeight = Math.max(1, availableHeight - 2);
    this.scroll = Math.max(0, Math.min(Math.max(0, lines.length - this.viewportHeight), this.scroll));
    const title = this.theme.fg("accent", `Agent Council · pair ${this.page + 1}/${this.pages}`);
    const controls = this.theme.fg("muted", `←/→ pair · ↑/↓ scroll · PgUp/PgDn · Home/End · Esc close · ${this.scroll + 1}–${Math.min(lines.length, this.scroll + this.viewportHeight)}/${lines.length}`);
    const visible = lines.slice(this.scroll, this.scroll + this.viewportHeight);
    if (!framed) return [truncateToWidth(title, width, "…"), ...visible, truncateToWidth(controls, width, "…")];
    const border = (s: string) => this.theme.fg("borderAccent", s);
    const fill = (s: string) => truncateToWidth(s, contentWidth, "…", true);
    return [border("┌─") + fill(title) + border("─┐"), ...visible.map(s => border("│ ") + fill(s) + border(" │")), border("└─") + fill(controls) + border("─┘")].map(s => this.theme.bg?.("customMessageBg", s) ?? s);
  }
}
