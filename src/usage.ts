import type { Usage } from "@earendil-works/pi-ai";
import type { CouncilResult } from "./council.ts";

export interface UsageRow {
  call: string;
  tokens: string;
  cost: string;
  duration: string;
}
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const tokens = (value: unknown) => number(value) ? String(value) : "—";
const cost = (value: unknown) => number(value) ? `$${value.toFixed(4)}` : "—";
const duration = (value: unknown) => number(value) ? `${(value / 1000).toFixed(1)}s` : "—";

export function usageSummary(result: CouncilResult): { rows: UsageRow[]; partial: boolean } {
  const calls = result.members.map(m => ({ call: m.member.label, attempted: !!m.opinion || !!m.model || m.durationMs !== undefined || !!m.usage, usage: m.usage, durationMs: m.durationMs }));
  if (result.synthesizer || result.synthesisUsage || result.synthesisDurationMs !== undefined) {
    calls.push({ call: "Comparison", attempted: true, usage: result.synthesisUsage, durationMs: result.synthesisDurationMs });
  }
  const attempted = calls.filter(c => c.attempted);
  const fields = ["input", "output", "totalTokens"] as const;
  const sums = fields.map(field => {
    const known = attempted.map(c => c.usage?.[field]).filter(number);
    return known.length ? known.reduce((a, b) => a + b, 0) : undefined;
  });
  const costs = attempted.map(c => c.usage?.cost?.total).filter(number);
  const partial = attempted.some(c => fields.some(f => !number(c.usage?.[f])) || !number(c.usage?.cost?.total));
  const formatTokens = (usage?: Usage) => fields.map(f => tokens(usage?.[f])).join(" / ");
  const rows = calls.map(c => ({ call: c.call, tokens: c.attempted ? formatTokens(c.usage) : "Not called", cost: cost(c.usage?.cost?.total), duration: duration(c.durationMs) }));
  rows.push({ call: partial ? "Total (partial)" : "Total", tokens: sums.map(tokens).join(" / "), cost: cost(costs.length ? costs.reduce((a, b) => a + b, 0) : undefined), duration: duration(result.durationMs) });
  return { rows, partial };
}

export const USAGE_NOTE = "Costs are reported by Pi and may differ from billing. Total tokens include any reported cache usage; total duration is elapsed wall time.";

export function renderUsage(result: CouncilResult): string {
  // Prevent labels from injecting Markdown rows or terminal controls.
  const label = (s: string) => s.replace(/[\u0000-\u001f\u007f|<>`#*_\[\]\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return ["### Usage", "| Call | Tokens (input/output/total) | Reported cost (USD) | Duration |", "|---|---|---|---|", ...usageSummary(result).rows.map(r => `| ${label(r.call)} | ${r.tokens} | ${r.cost} | ${r.duration} |`), "", USAGE_NOTE].join("\n");
}
