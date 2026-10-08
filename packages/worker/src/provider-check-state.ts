/**
 * Stored results of provider checks (./provider-check.ts): one per discovered
 * provider, valid while the fingerprint of its configuration and the
 * runtime's login matches.
 */
import { createHash } from "node:crypto";
import type { ProviderHealth } from "@bd777/foundry-protocol";
import { foundryStatePath } from "./state-root.js";
import { readOptionalText } from "./utils.js";
import type { AgentProfileLocalConfig } from "./profiles.js";

export interface ProviderCheck {
  status: "passed" | "failed";
  checkedAt: string;
  /** Why it failed, in the agent's words. */
  message?: string;
  /** The configuration this result is about. */
  fingerprint: string;
}

export const providerChecksPath = () =>
  foundryStatePath("provider-checks.json");
const retryFailedMs = 60 * 60 * 1000;

/** Providers that only count as usable once a check has passed. */
export function needsProviderCheck(profile: AgentProfileLocalConfig): boolean {
  return (
    profile.discovered === true &&
    (profile.connectionType === "openai_compatible" ||
      profile.connectionType === "anthropic_compatible")
  );
}

export function readProviderChecks(): Record<string, ProviderCheck> {
  try {
    const parsed: unknown = JSON.parse(
      readOptionalText(providerChecksPath()) || "{}",
    );
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, ProviderCheck>)
      : {};
  } catch {
    return {};
  }
}

/**
 * What a check result is about: the provider's definition, its key (hashed),
 * and the runtime's login, since a provider may run on that login.
 */
export function providerCheckFingerprint(
  profile: AgentProfileLocalConfig,
  health: ProviderHealth[],
): string {
  const login = health.find((row) => row.provider === profile.runtime);
  return createHash("sha256")
    .update(
      JSON.stringify({
        runtime: profile.runtime,
        codexModelProvider: profile.codexModelProvider,
        baseUrl: profile.baseUrl,
        model: profile.model,
        key: profile.apiKey?.trim() ?? "",
        keySource: profile.keySource,
        login: [login?.status, login?.authMode, login?.accountLabel],
      }),
    )
    .digest("hex");
}

/** The current check of a provider, or undefined when none applies yet. */
export function currentProviderCheck(
  id: string,
  profile: AgentProfileLocalConfig,
  health: ProviderHealth[],
  checks: Record<string, ProviderCheck> = readProviderChecks(),
): ProviderCheck | undefined {
  const check = checks[id];
  return check?.fingerprint === providerCheckFingerprint(profile, health)
    ? check
    : undefined;
}

export function providerCheckDue(
  id: string,
  profile: AgentProfileLocalConfig,
  health: ProviderHealth[],
  checks: Record<string, ProviderCheck>,
): boolean {
  const check = currentProviderCheck(id, profile, health, checks);
  if (!check) return true;
  return (
    check.status === "failed" &&
    Date.now() - Date.parse(check.checkedAt) > retryFailedMs
  );
}
