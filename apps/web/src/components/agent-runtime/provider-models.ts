import type {
  AgentProfileProjection,
  ProfileDefinition,
} from "@bd777/foundry-protocol";

export type ProviderKind =
  "subscription" | "api" | "environment" | "discovered";

export interface ProviderModelSource {
  key: string;
  providerKind: ProviderKind;
  providerId: string;
  providerLabel: string;
  runtime: "claude" | "codex";
  model: string;
}

export interface ProviderModelGroup {
  key: string;
  label: string;
  kind: ProviderKind;
  runtime: "claude" | "codex";
  models: ProviderModelSource[];
}

export function providerKindOf(
  profile: AgentProfileProjection,
): ProviderKind | undefined {
  if (profile.connectionType === "local_login") return "subscription";
  if (profile.connectionType === "external") return "environment";
  if (
    profile.connectionType === "anthropic_compatible" ||
    profile.connectionType === "openai_compatible"
  )
    return profile.origin === "server" ? "api" : "discovered";
  return undefined;
}

function modelIds(profile: { model?: string; models?: string[] }): string[] {
  return [...new Set([profile.model ?? "", ...(profile.models ?? [])])].filter(
    Boolean,
  );
}

/** Every provider with models Foundry knows, grouped by provider and runtime. */
export function providerModelGroups(
  profiles: ProfileDefinition[],
  agentProfiles: AgentProfileProjection[],
  kinds: readonly ProviderKind[],
  runtimes: readonly string[],
): ProviderModelGroup[] {
  const sources = new Map<string, ProviderModelSource>();
  const add = (
    providerKind: ProviderKind,
    providerId: string,
    providerLabel: string,
    runtime: string,
    model: string,
  ) => {
    const source: ProviderModelSource = {
      key: [providerKind, providerId, runtime, model].join("\u0000"),
      providerKind,
      providerId,
      providerLabel,
      runtime: runtime as ProviderModelSource["runtime"],
      model,
    };
    sources.set(source.key, source);
  };
  for (const profile of profiles) {
    for (const model of modelIds(profile))
      add("api", profile.id, profile.label, profile.runtime, model);
  }
  for (const profile of agentProfiles) {
    const providerKind = providerKindOf(profile);
    if (!providerKind) continue;
    for (const model of modelIds(profile))
      add(providerKind, profile.id, profile.label, profile.runtime, model);
  }
  const grouped = new Map<string, ProviderModelGroup>();
  for (const source of sources.values()) {
    if (!kinds.includes(source.providerKind)) continue;
    if (!runtimes.includes(source.runtime)) continue;
    const key = [source.providerKind, source.providerId, source.runtime].join(
      "\u0000",
    );
    let group = grouped.get(key);
    if (!group) {
      group = {
        key,
        label: source.providerLabel,
        kind: source.providerKind,
        runtime: source.runtime,
        models: [],
      };
      grouped.set(key, group);
    }
    group.models.push(source);
  }
  return [...grouped.values()]
    .map((group) => ({
      ...group,
      models: group.models.sort((a, b) => a.model.localeCompare(b.model)),
    }))
    .sort(
      (a, b) =>
        a.label.localeCompare(b.label) || a.runtime.localeCompare(b.runtime),
    );
}
