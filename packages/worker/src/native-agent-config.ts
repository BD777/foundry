/**
 * Discovery of agent profiles the user configured outside Foundry: Claude
 * Code's settings files, Codex's `config.toml`, and the endpoint variables the
 * daemon itself inherited. These are read-only observations — Foundry never
 * rewrites a native config — and they exist so a machine's real providers show
 * up on the device page instead of only the ones retyped into Foundry.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parse as parseTOML } from "smol-toml";
import type { AgentProfileLocalConfig } from "./profiles.js";

export interface DiscoveredProfile extends AgentProfileLocalConfig {
  /** Where the profile was observed, shown verbatim in the UI. */
  configLabel: string;
}

const claudeSettingsPaths = [
  resolve(homedir(), ".claude", "settings.json"),
  resolve(homedir(), ".claude", "settings.local.json"),
];
const codexConfigPath = resolve(homedir(), ".codex", "config.toml");

function readJSONObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringField(
  source: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Claude Code reads its endpoint from `env` in the settings files, so a custom
 * relay lives there rather than in any provider list.
 */
export function claudeSettingsProfiles(
  paths: string[] = claudeSettingsPaths,
): DiscoveredProfile[] {
  const discovered: DiscoveredProfile[] = [];
  for (const path of paths) {
    const settings = readJSONObject(path);
    const env = settings?.env;
    const envRecord =
      env && typeof env === "object"
        ? (env as Record<string, unknown>)
        : undefined;
    const baseUrl = stringField(envRecord, "ANTHROPIC_BASE_URL");
    if (!baseUrl) continue;
    const apiKey =
      stringField(envRecord, "ANTHROPIC_AUTH_TOKEN") ??
      stringField(envRecord, "ANTHROPIC_API_KEY");
    discovered.push({
      apiKey,
      baseUrl,
      configLabel: path.replace(homedir(), "~"),
      connectionType: "anthropic_compatible",
      id: `claude_settings_${discovered.length}`,
      label: `Claude Code endpoint (${new URL(baseUrl).host})`,
      model: stringField(envRecord, "ANTHROPIC_MODEL"),
      runtime: "claude",
    });
  }
  return discovered;
}

/**
 * Codex keeps custom endpoints in `[model_providers.*]`; `env_key` names the
 * variable holding the key, so the key itself is read from the environment the
 * daemon runs in, exactly like Codex would.
 */
export function codexConfigProfiles(
  path: string = codexConfigPath,
  env: NodeJS.ProcessEnv = process.env,
): DiscoveredProfile[] {
  if (!existsSync(path)) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = parseTOML(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return [];
  }
  const providers = parsed.model_providers;
  if (!providers || typeof providers !== "object") return [];
  const defaultModel = stringField(parsed, "model");

  return Object.entries(providers as Record<string, unknown>)
    .map(([key, value]): DiscoveredProfile | undefined => {
      const provider =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : undefined;
      const baseUrl = stringField(provider, "base_url");
      if (!baseUrl) return undefined;
      const envKey = stringField(provider, "env_key");
      return {
        apiKey: envKey ? env[envKey]?.trim() : undefined,
        baseUrl,
        configLabel: path.replace(homedir(), "~"),
        connectionType: "openai_compatible" as const,
        id: `codex_provider_${key}`,
        label: stringField(provider, "name") ?? `Codex provider ${key}`,
        model: defaultModel,
        runtime: "codex" as const,
      };
    })
    .filter((profile): profile is DiscoveredProfile => Boolean(profile));
}

/**
 * A wrapper script or shell profile can point an agent at a relay purely
 * through the environment, which is invisible in every config file. The daemon
 * inherits that environment, so the endpoint it would actually call is
 * reported too.
 */
export function environmentProfiles(
  env: NodeJS.ProcessEnv = process.env,
): DiscoveredProfile[] {
  const discovered: DiscoveredProfile[] = [];
  const anthropicBase = env.ANTHROPIC_BASE_URL?.trim();
  if (anthropicBase) {
    discovered.push({
      apiKey:
        env.ANTHROPIC_AUTH_TOKEN?.trim() || env.ANTHROPIC_API_KEY?.trim() || "",
      baseUrl: anthropicBase,
      configLabel: "daemon environment (ANTHROPIC_BASE_URL)",
      connectionType: "anthropic_compatible",
      id: "claude_env_endpoint",
      label: `Claude endpoint (${new URL(anthropicBase).host})`,
      model: env.ANTHROPIC_MODEL?.trim(),
      runtime: "claude",
    });
  }
  const openaiBase = env.OPENAI_BASE_URL?.trim();
  if (openaiBase) {
    discovered.push({
      apiKey: env.OPENAI_API_KEY?.trim() || "",
      baseUrl: openaiBase,
      configLabel: "daemon environment (OPENAI_BASE_URL)",
      connectionType: "openai_compatible",
      id: "codex_env_endpoint",
      label: `Codex endpoint (${new URL(openaiBase).host})`,
      model: env.OPENAI_MODEL?.trim(),
      runtime: "codex",
    });
  }
  return discovered;
}

/**
 * Every profile the machine's own agent configuration implies. Duplicate
 * endpoints collapse: the same runtime and base URL described twice is one
 * provider, and the first source wins so a config file outranks an inherited
 * variable.
 */
export function nativeAgentProfiles(): DiscoveredProfile[] {
  const byEndpoint = new Map<string, DiscoveredProfile>();
  for (const profile of [
    ...claudeSettingsProfiles(),
    ...codexConfigProfiles(),
    ...environmentProfiles(),
  ]) {
    const key = `${profile.runtime}:${profile.baseUrl}`;
    if (!byEndpoint.has(key)) byEndpoint.set(key, profile);
  }
  return [...byEndpoint.values()];
}
