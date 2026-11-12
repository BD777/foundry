import type {
  AgentProfileProjection,
  ProfileDefinition,
} from "@bd777/foundry-protocol";
import { providerKindOf } from "../agent-runtime/provider-models";
import { i18n } from "../../i18n";
import { runtimeMeta } from "../agent-runtime/runtime-mark";

export interface ExecutionSource {
  key: string;
  providerKind: string;
  providerId: string;
  runtime: AgentProfileProjection["runtime"];
  label: string;
  profile?: AgentProfileProjection;
  defaultModel: string;
  models: string[];
  devices: number;
}

export function executionSources(
  agentProfiles: AgentProfileProjection[],
  profiles: ProfileDefinition[],
): ExecutionSource[] {
  const grouped = new Map<string, ExecutionSource>();
  const add = (
    providerKind: string,
    providerId: string,
    runtime: string,
    label: string,
    defaultModel: string,
    models: string[],
    profile?: AgentProfileProjection,
  ) => {
    const key = `${providerKind}\u0000${providerId}\u0000${runtime}`;
    const found = grouped.get(key);
    if (found) {
      found.devices += profile ? 1 : 0;
      found.profile ??= profile;
      found.models = [...new Set([...found.models, ...models])];
      return;
    }
    grouped.set(key, {
      key,
      providerKind,
      providerId,
      runtime: runtime as AgentProfileProjection["runtime"],
      label,
      profile,
      defaultModel,
      models,
      devices: profile ? 1 : 0,
    });
  };
  for (const profile of profiles)
    add(
      "api",
      profile.id,
      profile.runtime,
      profile.label,
      profile.model ?? "",
      profile.models ?? [],
    );
  for (const profile of agentProfiles) {
    const providerKind = providerKindOf(profile);
    if (!providerKind) continue;
    const key = `${providerKind}\u0000${profile.id}\u0000${profile.runtime}`;
    add(
      providerKind,
      profile.id,
      profile.runtime,
      profile.label,
      profile.model ?? "",
      profile.models ?? [],
      profile,
    );
    const found = grouped.get(key);
    if (found) found.defaultModel ||= profile.model ?? "";
  }
  return [...grouped.values()].sort(
    (a, b) =>
      a.label.localeCompare(b.label) || a.runtime.localeCompare(b.runtime),
  );
}

/** Model ids a source offers: its default first, then the rest. */
export function sourceModels(source: ExecutionSource): string[] {
  return [
    ...new Set([
      ...(source.defaultModel ? [source.defaultModel] : []),
      ...source.models,
    ]),
  ];
}

/** Runtime and device count, the second line of a provider option. */
export function executionSourceMeta(source: ExecutionSource): string {
  return [
    runtimeMeta(source.runtime).label,
    source.devices
      ? i18n.t("executionDefault.deviceCount", {
          ns: "agents",
          count: source.devices,
        })
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
