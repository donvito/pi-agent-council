import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { MemberConfig } from "./config.ts";

type Registry = Pick<ModelRegistry, "getAll" | "hasConfiguredAuth">;
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export function resolveMember(member: MemberConfig, registry: Registry): Model<Api> {
  const pool = registry.getAll().filter(m => !member.provider || m.provider === member.provider);
  // Exact IDs always take precedence over normalized IDs or display names.
  const exact = pool.filter(m => m.id === member.model);
  const candidates = exact.length ? exact : pool.filter(m => normalize(m.id) === normalize(member.model) || normalize(m.name) === normalize(member.model));
  const authenticated = candidates.filter(m => registry.hasConfiguredAuth(m));
  if (authenticated.length === 1) return authenticated[0];
  if (!candidates.length) throw new Error(`Model "${member.model}" is absent from Pi's registry. Use /model or pi --list-models, then set its exact provider and model in council.json.`);
  if (!authenticated.length) throw new Error(`No Pi authentication for ${candidates.map(m => `${m.provider}/${m.id}`).join(", ")}. Use /login or your existing Pi provider configuration.`);
  throw new Error(`Ambiguous model: ${authenticated.map(m => `${m.provider}/${m.id}`).join(", ")}. Set an explicit provider in council.json.`);
}
