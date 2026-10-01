import { buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";

export function snapshotContext(entries: SessionEntry[], maxChars: number): string {
  // Pi resolves compaction, branch summaries and context edits before serialization.
  const { messages } = buildSessionContext(entries);
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (!("content" in message)) continue;
    const content = message.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((block: unknown) => {
      if (!block || typeof block !== "object") return "";
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (b.type === "toolCall") return `Tool call: ${b.name} ${JSON.stringify(b.arguments)}`;
      if (b.type === "image") return "[Image omitted; council receives text only.]";
      return ""; // Omit hidden thinking and provider-specific content.
    }).filter(Boolean).join("\n") : "";
    if (text) parts.push(`[${message.role}${"toolName" in message ? `: ${message.toolName}` : ""}]\n${text}`);
  }
  const full = parts.join("\n\n") || "[No earlier session context.]";
  if (full.length <= maxChars) return full;
  const marker = "[Earlier context omitted to fit the council context limit.]\n";
  return marker + full.slice(-(maxChars - marker.length));
}
