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

/**
 * A profile with the person's defaults over the ones it was given. A saved
 * model applies only while the connection still offers it; otherwise the
 * connection's own default stands.
 */
export function withExternalProfileDefaults<
  T extends { model?: string; models?: string[] } & ExternalProfileDefaults,
>(profile: T, defaults: ExternalProfileDefaults | undefined): T {
  if (!defaults) return profile;
  const { model, ...rest } = defaults;
  const offered =
    !!model && (!profile.models?.length || profile.models.includes(model));
  return {
    ...profile,
    ...Object.fromEntries(
      Object.entries(rest).filter(([, value]) => value !== undefined),
    ),
    ...(offered ? { model } : {}),
  };
}
