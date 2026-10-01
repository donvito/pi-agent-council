import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface MemberConfig {
  label: string;
  model: string;
  provider?: string;
}
export interface CouncilConfig {
  members: MemberConfig[];
  timeoutMs: number;
  maxContextChars: number;
  maxOutputTokens: number;
}
export const DEFAULT_CONFIG: CouncilConfig = {
  members: [
    { label: "GPT-6.1 Sol", model: "gpt-6.1-sol" },
    { label: "Claude Opus 5.5", model: "claude-opus-5-5" },
    { label: "GPT-6 Astra", model: "gpt-6-astra" },
  ],
  timeoutMs: 120_000,
  maxContextChars: 48_000,
  maxOutputTokens: 4096,
};

export function parseConfig(value: unknown): CouncilConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Council config must be an object.");
  const raw = value as Record<string, unknown>;
  const members = raw.members ?? DEFAULT_CONFIG.members;
  if (!Array.isArray(members) || members.length < 2 || members.length > 8) throw new Error("Configure 2–8 council members.");
  const parsed = members.map((item): MemberConfig => {
    if (!item || typeof item !== "object") throw new Error("Each member needs label and model strings.");
    const m = item as Record<string, unknown>;
    for (const key of ["label", "model"]) {
      if (typeof m[key] !== "string" || !(m[key] as string).trim() || (m[key] as string).length > 200) throw new Error(`Invalid member ${key}.`);
    }
    if (m.provider !== undefined && (typeof m.provider !== "string" || !m.provider.trim())) throw new Error("Invalid member provider.");
    return { label: (m.label as string).trim(), model: (m.model as string).trim(), provider: (m.provider as string | undefined)?.trim() };
  });
  if (new Set(parsed.map(m => m.label)).size !== parsed.length) throw new Error("Member labels must be unique.");
  const integer = (key: "timeoutMs" | "maxContextChars" | "maxOutputTokens", min: number, max: number) => {
    const n = raw[key] ?? DEFAULT_CONFIG[key];
    if (!Number.isInteger(n) || (n as number) < min || (n as number) > max) throw new Error(`${key} must be an integer from ${min} to ${max}.`);
    return n as number;
  };
  return { members: parsed, timeoutMs: integer("timeoutMs", 1000, 600_000), maxContextChars: integer("maxContextChars", 1000, 200_000), maxOutputTokens: integer("maxOutputTokens", 512, 16_384) };
}

export async function loadConfig(cwd: string, agentDir: string, projectTrusted: boolean): Promise<CouncilConfig> {
  const explicit = process.env.PI_COUNCIL_CONFIG;
  const paths = explicit ? [resolve(cwd, explicit)] : [resolve(agentDir, "council.json"), ...(projectTrusted ? [resolve(cwd, ".pi/council.json")] : [])];
  let merged: Record<string, unknown> = {};
  for (const path of paths) {
    try {
      const data: unknown = JSON.parse(await readFile(path, "utf8"));
      // Validate every layer, including the global config when a project overrides it.
      parseConfig(data);
      merged = { ...merged, ...data as Record<string, unknown> };
    } catch (error) {
      if (!explicit && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`Cannot load ${path}: ${error instanceof Error ? error.message : "invalid config"}`);
    }
  }
  return parseConfig(merged);
}
