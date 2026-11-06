import { foundryStatePath } from "../platform/state-root.js";
import {
  tryReadJSONFile,
  writePrivateJSONAtomic,
} from "../platform/storage.js";
import type { AgentProfileProjection } from "@bd777/foundry-protocol";

/**
 * The person's own defaults for external connections (a connector's model
 * provider, or one a gateway installer registered): the connection belongs
 * to whoever gives it and is re-listed every few minutes, the defaults
 * belong to the person. Kept apart, by profile id, so re-listing, a provider
 * that cannot be used for a while, or signing out and back in leaves them.
 */
export interface ExternalProfileDefaults {
  model?: string;
  claudeEffort?: AgentProfileProjection["claudeEffort"];
  claudePermissionMode?: AgentProfileProjection["claudePermissionMode"];
  codexApprovalPolicy?: AgentProfileProjection["codexApprovalPolicy"];
  codexReasoningEffort?: AgentProfileProjection["codexReasoningEffort"];
  codexSandboxMode?: AgentProfileProjection["codexSandboxMode"];
  codexSpeed?: AgentProfileProjection["codexSpeed"];
  contextWindows?: Record<string, number>;
}

interface DefaultsFile {
  profiles?: Record<string, ExternalProfileDefaults>;
}

export function externalProfileDefaultsPath(): string {
  return foundryStatePath("external-profile-defaults.json");
}

export function externalProfileDefaults(): Record<
  string,
  ExternalProfileDefaults
> {
  return (
    tryReadJSONFile<DefaultsFile>(externalProfileDefaultsPath())?.profiles ?? {}
  );
}

/** Replaces one profile's defaults; empty ones are removed. */
export function saveExternalProfileDefaults(
  profileId: string,
  defaults: ExternalProfileDefaults,
): void {
  const set = Object.fromEntries(
    Object.entries(defaults).filter(
      ([, value]) =>
        value !== undefined &&
        value !== "" &&
        !(typeof value === "object" && !Object.keys(value).length),
    ),
  ) as ExternalProfileDefaults;
  const profiles = { ...externalProfileDefaults() };
  if (Object.keys(set).length) profiles[profileId] = set;
  else delete profiles[profileId];
  writePrivateJSONAtomic(externalProfileDefaultsPath(), { profiles });
}

type WithDefaults = {
  models?: string[];
  asGiven?: ExternalProfileDefaults;
} & ExternalProfileDefaults;

/**
 * A profile with the person's defaults over the ones it was given. A saved
 * model applies only while the connection still offers it; otherwise the
 * connection's own default stands. What the defaults replaced is kept in
 * `asGiven` (undefined values included), so the connection as its connector
 * gave it can be recovered (externalConnectionAsGiven).
 */
export function withExternalProfileDefaults<T extends WithDefaults>(
  profile: T,
  defaults: ExternalProfileDefaults | undefined,
): T {
  if (!defaults) return profile;
  const { model, ...rest } = defaults;
  const offered =
    !!model && (!profile.models?.length || profile.models.includes(model));
  const applied: ExternalProfileDefaults = {
    ...Object.fromEntries(
      Object.entries(rest).filter(([, value]) => value !== undefined),
    ),
    ...(offered ? { model } : {}),
  };
  const keys = Object.keys(applied) as (keyof ExternalProfileDefaults)[];
  if (!keys.length) return profile;
  return {
    ...profile,
    ...applied,
    asGiven: Object.fromEntries(keys.map((key) => [key, profile[key]])),
  };
}

/**
 * The connection as its connector gave it, without the person's defaults. A
 * provider check is about the connection, not the person's choice of model,
 * so it runs and is fingerprinted on this (provider-check-state.ts); saving
 * a default therefore leaves a passed check standing.
 */
export function externalConnectionAsGiven<T extends WithDefaults>(
  profile: T,
): T {
  if (!profile.asGiven) return profile;
  const { asGiven, ...given } = profile;
  return { ...given, ...asGiven } as T;
}
