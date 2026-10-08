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
    const keyName = stringField(envRecord, "ANTHROPIC_AUTH_TOKEN")
      ? "ANTHROPIC_AUTH_TOKEN"
      : stringField(envRecord, "ANTHROPIC_API_KEY")
        ? "ANTHROPIC_API_KEY"
        : undefined;
    const apiKey = keyName ? stringField(envRecord, keyName) : undefined;
    discovered.push({
      apiKey,
      baseUrl,
      configLabel: path.replace(homedir(), "~"),
      configSection: "env.ANTHROPIC_BASE_URL",
      keySource: keyName ? `env.${keyName}` : "none",
      keyCheckable: keyName ? undefined : false,
      connectionType: "anthropic_compatible",
      id: `claude_settings_${discovered.length}`,
      label: `Claude Code endpoint (${new URL(baseUrl).host})`,
      model: stringField(envRecord, "ANTHROPIC_MODEL"),
      runtime: "claude",
    });
  }
  return discovered;
}

function authorizationHeader(
  headers: unknown,
): [name: string, value: string] | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  return Object.entries(headers as Record<string, unknown>).find(
    (entry): entry is [string, string] =>
      entry[0].toLowerCase() === "authorization" &&
      typeof entry[1] === "string",
  );
}

/**
 * Where a Codex provider gets its credential, in the order Codex offers them:
 * an env var (`env_key`), a token in the file, the ChatGPT/OpenAI login, an
 * auth command, or an Authorization header. A login or command has no key
 * here to check (keyCheckable false); "none" means no credential is sent.
 */
function codexProviderCredential(
  provider: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv,
): Pick<DiscoveredProfile, "apiKey" | "keySource" | "keyCheckable"> {
  const envKey = stringField(provider, "env_key");
  if (envKey)
    return {
      apiKey: env[envKey]?.trim() || undefined,
      keySource: `$${envKey}`,
    };
  const token = stringField(provider, "experimental_bearer_token");
  if (token)
    return {
      apiKey: token,
      keySource: "experimental_bearer_token",
    };
  if (provider?.requires_openai_auth === true)
    return { keySource: "requires_openai_auth", keyCheckable: false };
  if (provider?.auth && typeof provider.auth === "object")
    return { keySource: "auth", keyCheckable: false };
  const envHeader = authorizationHeader(provider?.env_http_headers);
  if (envHeader)
    return {
      apiKey: env[envHeader[1]]?.replace(/^Bearer\s+/i, "").trim() || undefined,
      keySource: `env_http_headers.${envHeader[0]} ($${envHeader[1]})`,
    };
  const header = authorizationHeader(provider?.http_headers);
  if (header)
    return {
      apiKey: header[1].replace(/^Bearer\s+/i, "").trim() || undefined,
      keySource: `http_headers.${header[0]}`,
    };
  return { keySource: "none", keyCheckable: false };
}

/**
 * The model providers Codex itself uses: the one `model_provider` selects and
 * those its `[profiles]` select, each with the model it is used with. A
 * provider only defined in the file is not one Codex runs, so Foundry does not
 * offer it either.
 */
function referencedCodexProviders(
  parsed: Record<string, unknown>,
): Map<string, string | undefined> {
  const defaultModel = stringField(parsed, "model");
  const referenced = new Map<string, string | undefined>();
  const active = stringField(parsed, "model_provider");
  if (active) referenced.set(active, defaultModel);
  const profiles =
    parsed.profiles && typeof parsed.profiles === "object"
      ? Object.values(parsed.profiles as Record<string, unknown>)
      : [];
  for (const profile of profiles) {
    const fields =
      profile && typeof profile === "object"
        ? (profile as Record<string, unknown>)
        : undefined;
    const provider = stringField(fields, "model_provider");
    if (provider && !referenced.has(provider))
      referenced.set(provider, stringField(fields, "model") ?? defaultModel);
  }
  return referenced;
}

/**
 * Codex's custom endpoints in `[model_providers.*]` that Codex actually uses.
 * Foundry runs one by its name, so Codex applies its own definition (auth,
 * headers, wire API); the key, when there is one, is read only to tell
 * duplicates apart. The same endpoint with the same credential is one
 * provider, however many names point at it.
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
  const providers =
    parsed.model_providers && typeof parsed.model_providers === "object"
      ? (parsed.model_providers as Record<string, unknown>)
      : {};
  const seen = new Set<string>();
  const discovered: DiscoveredProfile[] = [];
  for (const [key, model] of referencedCodexProviders(parsed)) {
    const value = providers[key];
    const provider =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : undefined;
    const baseUrl = stringField(provider, "base_url");
    if (!baseUrl) continue;
    const credential = codexProviderCredential(provider, env);
    const identity = `${baseUrl.replace(/\/+$/, "")}\n${credential.apiKey ?? credential.keySource}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    discovered.push({
      ...credential,
      baseUrl,
      codexModelProvider: key,
      configLabel: path.replace(homedir(), "~"),
      configSection: `model_providers.${key}`,
      connectionType: "openai_compatible" as const,
      id: `codex_provider_${key}`,
      label: stringField(provider, "name") ?? `Codex provider ${key}`,
      model,
      runtime: "codex" as const,
    });
  }
  return discovered;
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
      keySource: env.ANTHROPIC_AUTH_TOKEN?.trim()
        ? "$ANTHROPIC_AUTH_TOKEN"
        : "$ANTHROPIC_API_KEY",
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
      keySource: "$OPENAI_API_KEY",
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
