import { nativeCli } from "./native-cli.js";
/**
 * Agent profile management — local config, runtime environment, and status.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  externalConnectionAvailable,
  externalConnectionBaseEnvironment,
  type ExternalConnectionConfig,
} from "./external-connection.js";
import { foundryStatePath } from "./state-root.js";
import {
  normalizeProviderBaseUrl,
  type AgentConfigScope,
  type AgentConnectionType,
  type AgentProfileProjection,
  type AgentProjection,
  type AgentSession,
  type DeviceProjection,
  type ExternalConnectionSetupInfo,
  type ProfileDefinition,
  type ProfileOrigin,
  type ProviderHealth,
  type SecretPlacement,
  type UpsertAgentProfilePayload,
} from "@bd777/foundry-protocol";
import { hardenPrivateFile, writeJSON } from "./storage.js";
import { readOptionalText, safeID } from "./utils.js";
import { getDevice } from "./device.js";
import {
  claudeContextWindowEnvironment,
  claudeRunModel,
  type SessionContextWindow,
} from "./context-window.js";
import { nativeAgentProfiles } from "./native-agent-config.js";
import { nativeLoginHealth } from "./native-login.js";
import { nativeLoginEnvironment } from "./native-login-environment.js";
import { providerHealthData } from "./provider-health.js";
import {
  currentProviderCheck,
  needsProviderCheck,
  providerChecksPath,
} from "./provider-check-state.js";
import {
  projectedProfileAuthMode,
  projectedProfileStatusDetail,
} from "./agent-profile-state.js";

// --- Types ---

export interface AgentProfileLocalConfig {
  /** Device-installed connection helper. Never dispatched from the server. */
  externalConnection?: ExternalConnectionConfig;
  /**
   * How a gateway sets this external connection up on another device; not
   * part of the connection itself (nor its check fingerprint).
   */
  externalSetup?: ExternalConnectionSetupInfo;
  /** Internal host-to-sandbox execution context; never accepted from the server. */
  preparedExternalConfigHome?: string;
  preparedExternalEnvironment?: Record<string, string>;
  apiKey?: string;
  /** Where in its config file a discovered profile is defined. */
  configSection?: string;
  /** Where its key comes from, by name only (an env var or settings key). */
  keySource?: string;
  /** False when the credential is a login or command, not a key to check. */
  keyCheckable?: boolean;
  /**
   * The original native provider id, retained as discovery provenance.
   * Execution materializes the selected connection instead of loading its file.
   */
  codexModelProvider?: string;
  /** Explicit snapshot of the selected native provider, never global CLI settings. */
  codexProviderConfig?: Record<string, unknown>;
  /** Found in the device's agent configuration rather than written for Foundry. */
  discovered?: boolean;
  baseUrl?: string;
  command?: string;
  claudeEffort?: AgentProfileProjection["claudeEffort"];
  claudePermissionMode?: AgentProfileProjection["claudePermissionMode"];
  codexApprovalPolicy?: AgentProfileProjection["codexApprovalPolicy"];
  codexReasoningEffort?: AgentProfileProjection["codexReasoningEffort"];
  codexSandboxMode?: AgentProfileProjection["codexSandboxMode"];
  codexSpeed?: AgentProfileProjection["codexSpeed"];
  connectionType?: AgentConnectionType;
  enabled?: boolean;
  env?: Record<string, string>;
  id?: string;
  label?: string;
  model?: string;
  /** Models offered for this profile; `model` is the default. */
  models?: string[];
  /** A server profile's per-model windows the person set. */
  contextWindows?: Record<string, number>;
  /** The window this run's model was resolved to (context-window.ts). */
  contextWindow?: SessionContextWindow;
  /** A server profile's Responses transport choice (codex-transport.ts). */
  codexTransport?: ProfileDefinition["codexTransport"];
  codexTransportLearned?: ProfileDefinition["codexTransportLearned"];
  /**
   * `server` marks a definition that came from the control plane for this run
   * only — it is never written to the local profiles file.
   */
  origin?: ProfileOrigin;
  promptPrefix?: string;
  runtime: AgentProjection["provider"];
}

export interface AgentProfilesLocalFile {
  profiles?: AgentProfileLocalConfig[];
}

// --- Constants ---

export const deviceAgentProfilesPath = foundryStatePath(
  "agent-profiles.local.json",
);

/**
 * Cheap heartbeat invalidation for local edits and explicit check results.
 * Not ctime: reading the profiles file re-applies its private mode, which
 * moves ctime and would re-report the device on every heartbeat.
 */
export function deviceProfileRevision(): string {
  return [deviceAgentProfilesPath, providerChecksPath()]
    .map((path) => {
      try {
        const stat = statSync(path);
        return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return "missing";
      }
    })
    .join(";");
}

export function readAgentProfilesFile(path: string): AgentProfilesLocalFile {
  if (!existsSync(path)) {
    return {};
  }
  hardenPrivateFile(path);
  const raw = readFileSync(path, "utf8");
  if (raw.trim() === "") {
    return {};
  }
  return JSON.parse(raw) as AgentProfilesLocalFile;
}

export function writeAgentProfilesFile(
  path: string,
  config: AgentProfilesLocalFile,
): void {
  writeJSON(path, {
    profiles: (config.profiles ?? []).filter(
      (profile) => profile.enabled !== false,
    ),
  });
}

export function builtInProfile(
  runtime: AgentProjection["provider"],
): AgentProfileLocalConfig {
  return {
    connectionType: "local_login",
    id: `${runtime}_local`,
    label: `${runtime === "codex" ? "Codex" : "Claude"} Local`,
    runtime,
  };
}

export function configuredAgentProfiles(
  _workspacePath: string,
  sources?: {
    device: AgentProfileLocalConfig[];
    native: ReturnType<typeof nativeAgentProfiles>;
  },
): Array<
  AgentProfileLocalConfig & {
    configLabel: string;
    configScope: AgentConfigScope;
  }
> {
  const deviceProfiles = (
    sources?.device ??
    readAgentProfilesFile(deviceAgentProfilesPath).profiles ??
    []
  ).map((profile) => ({
    ...profile,
    configLabel: "~/.foundry/agent-profiles.local.json",
    configScope: "device" as AgentConfigScope,
  }));
  // Profiles the machine's own agent configuration implies. They rank below
  // Foundry's file so a profile the user wrote here keeps its label and
  // settings, and below nothing else: an endpoint the agents really use should
  // be visible even if Foundry was never told about it.
  const native = (sources?.native ?? nativeAgentProfiles()).map((profile) => ({
    ...profile,
    discovered: true,
    configScope: "device" as AgentConfigScope,
  }));
  const defaults = [
    {
      ...builtInProfile("claude"),
      configLabel: "device local login",
      configScope: "device" as AgentConfigScope,
    },
    {
      ...builtInProfile("codex"),
      configLabel: "device local login",
      configScope: "device" as AgentConfigScope,
    },
  ];
  const byID = new Map<
    string,
    AgentProfileLocalConfig & {
      configLabel: string;
      configScope: AgentConfigScope;
    }
  >();
  for (const profile of [...defaults, ...native, ...deviceProfiles]) {
    if (
      profile.enabled === false ||
      (profile.runtime !== "claude" && profile.runtime !== "codex")
    ) {
      continue;
    }
    byID.set(profileID(profile), profile);
  }
  // A native discovery describing an endpoint the user also wrote into
  // Foundry's file is the same provider twice, and the hand-written one is the
  // authoritative copy.
  const authoredEndpoints = new Set(
    deviceProfiles
      .filter((profile) => profile.baseUrl)
      .map((profile) => `${profile.runtime}:${profile.baseUrl}`),
  );
  for (const profile of native) {
    if (authoredEndpoints.has(`${profile.runtime}:${profile.baseUrl}`)) {
      byID.delete(profileID(profile));
    }
  }
  // Older configs sometimes reused claude_local for a gateway. Preserve that
  // exact identity for history, but do not let it hide the native login.
  for (const runtime of ["claude", "codex"] as const) {
    if (
      ![...byID.values()].some(
        (profile) =>
          profile.runtime === runtime &&
          profile.connectionType === "local_login",
      )
    ) {
      let loginID = `foundry_official_${runtime}`;
      for (let suffix = 2; byID.has(loginID); suffix++)
        loginID = `foundry_official_${runtime}_${suffix}`;
      const login = {
        ...builtInProfile(runtime),
        id: loginID,
        configLabel: "device local login",
        configScope: "device" as AgentConfigScope,
      };
      byID.set(login.id, login);
    }
  }
  return [...byID.values()];
}

export function profileID(profile: AgentProfileLocalConfig): string {
  const seed =
    profile.id ||
    `${profile.runtime}_${profile.label ?? profile.connectionType ?? "profile"}`;
  return safeID(seed);
}

export function profileFingerprint(
  profile: Pick<
    AgentProfileLocalConfig,
    "baseUrl" | "command" | "connectionType" | "runtime" | "externalConnection"
  >,
): string {
  const runtime = profile.runtime;
  const connectionType = profile.connectionType ?? "local_login";
  if (connectionType === "external")
    return `${runtime}:external:${createHash("sha256")
      .update(JSON.stringify(profile.externalConnection ?? {}))
      .digest("hex")}`;
  if (connectionType === "local_login") {
    return `${runtime}:local_login`;
  }
  if (
    connectionType === "anthropic_compatible" ||
    connectionType === "openai_compatible"
  ) {
    return `${runtime}:${connectionType}:${normalizeEndpoint(profile.baseUrl)}`;
  }
  if (connectionType === "custom_command") {
    return `${runtime}:custom_command:${normalizeCommand(profile.command)}`;
  }
  return `${runtime}:${connectionType}`;
}

export function normalizeEndpoint(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/+$/, "").toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/, "").toLowerCase();
  }
}

export function normalizeCommand(value: string | undefined): string {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

export function maskCommand(command: string | undefined): string | undefined {
  if (!command?.trim()) {
    return undefined;
  }
  return command.trim().replace(/\s+/g, " ").slice(0, 96);
}

export function localHealthForProfile(
  profile: AgentProfileLocalConfig,
  healthData: ProviderHealth[],
): ProviderHealth | undefined {
  return healthData.find((item) => item.provider === profile.runtime);
}

/**
 * Where the credential backing this profile lives. A dispatched server
 * definition — and a local profile whose key was replaced by a dispatched
 * credential — is sealed in the control plane; everything else is this
 * machine's own configuration.
 */
export function profileSecretPlacement(
  profile: AgentProfileLocalConfig,
): SecretPlacement {
  return profile.origin === "server" ? "server" : "local";
}

/**
 * Remote endpoint profiles can be backed by a credential sealed in the control
 * plane, which this machine cannot see. Calling them `missing_auth` because the
 * local file holds no key is a false negative, so the daemon defers that
 * verdict to the server. Profiles that describe machine-local state — local
 * login, environment variables, a custom command — stay the daemon's call.
 */
export function profileHasAuth(
  profile: AgentProfileLocalConfig,
  healthData: ProviderHealth[] = providerHealthData(),
): boolean {
  if (profile.connectionType === "external")
    return (
      profile.runtime === "claude" &&
      profile.origin !== "server" &&
      externalConnectionAvailable(profile.externalConnection)
    );
  if (profile.connectionType === "local_login") {
    const health = localHealthForProfile(profile, healthData);
    return health?.authMode !== "missing";
  }
  if (profile.origin === "server" || profile.apiKey?.trim()) {
    return true;
  }
  const env = profile.env ?? {};
  if (
    credentialEnvNames(profile.runtime).some((key) =>
      Boolean(env[key]?.trim() || process.env[key]?.trim()),
    )
  ) {
    return true;
  }
  return (
    profile.connectionType === "anthropic_compatible" ||
    profile.connectionType === "openai_compatible"
  );
}

export function profileStatus(
  profile: AgentProfileLocalConfig,
  healthData: ProviderHealth[] = providerHealthData(),
): AgentProfileProjection["status"] {
  if (profile.connectionType === "local_login") {
    return localHealthForProfile(profile, healthData)?.status ?? "unavailable";
  }
  if (profile.connectionType === "custom_command") {
    return profile.command?.trim() ? "healthy" : "unavailable";
  }
  if (!profileHasAuth(profile, healthData)) {
    return "missing_auth";
  }
  if (
    (profile.connectionType === "anthropic_compatible" ||
      profile.connectionType === "openai_compatible") &&
    !profile.baseUrl?.trim()
  ) {
    return "unavailable";
  }
  return "healthy";
}

export function profileStatusDetail(
  profile: AgentProfileLocalConfig,
  healthData: ProviderHealth[] = providerHealthData(),
): string | undefined {
  return projectedProfileStatusDetail({
    baseUrl: profile.baseUrl,
    command: profile.command,
    connectionType: profile.connectionType,
    hasAuth: profileHasAuth(profile, healthData),
    localHealth: localHealthForProfile(profile, healthData),
  });
}

export function profileAuthMode(
  profile: AgentProfileLocalConfig,
  healthData: ProviderHealth[] = providerHealthData(),
): AgentProfileProjection["authMode"] {
  if (
    profile.connectionType === "local_login" ||
    profile.connectionType === "custom_command"
  ) {
    return projectedProfileAuthMode({
      baseUrl: profile.baseUrl,
      command: profile.command,
      connectionType: profile.connectionType,
      hasAuth: profileHasAuth(profile, healthData),
      localHealth: localHealthForProfile(profile, healthData),
    });
  }
  if (
    profile.connectionType === "env" ||
    Object.keys(profile.env ?? {}).length > 0
  ) {
    return "env";
  }
  return projectedProfileAuthMode({
    baseUrl: profile.baseUrl,
    command: profile.command,
    connectionType: profile.connectionType,
    hasAuth: profileHasAuth(profile, healthData),
    localHealth: localHealthForProfile(profile, healthData),
  });
}

export function agentProfilesForWorkspace(
  device: DeviceProjection,
  workspacePath: string,
  healthData?: ProviderHealth[],
): AgentProfileProjection[] {
  return configuredAgentProfiles(workspacePath).map((profile) => {
    const health =
      healthData ??
      (profile.connectionType === "local_login"
        ? [nativeLoginHealth(profile.runtime)]
        : providerHealthData());
    const id = profileID(profile);
    return {
      id,
      runtimeGeneration: nativeCli(profile.runtime).generation,
      // Only a local login has an account to name; endpoint profiles
      // authenticate with a key, which identifies nobody.
      accountLabel:
        profile.connectionType === "local_login"
          ? localHealthForProfile(profile, health)?.accountLabel
          : undefined,
      authMode: profileAuthMode(profile, health),
      baseUrl: profile.baseUrl,
      commandLabel: maskCommand(profile.command),
      configLabel: profile.configLabel,
      configScope: profile.configScope,
      configSection: profile.configSection,
      connectionType: profile.connectionType ?? "custom_command",
      ...(profile.connectionType === "external" && profile.externalSetup
        ? { externalSetup: profile.externalSetup }
        : {}),
      deviceId: device.id,
      fingerprint: profileFingerprint(profile),
      label:
        profile.label?.trim() ||
        (profile.runtime === "codex" ? "Codex" : "Claude"),
      lastSeenLabel: device.lastSeenLabel,
      model: profile.model,
      models: profile.models,
      contextWindows: profile.contextWindows,
      /* Reported so a saved value round-trips; nothing injects it and no field
         offers it, so a stale env var must not revive one either. */
      promptPrefix: profile.promptPrefix,
      claudeEffort: profile.claudeEffort,
      claudePermissionMode: profile.claudePermissionMode,
      codexApprovalPolicy: profile.codexApprovalPolicy,
      codexReasoningEffort: profile.codexReasoningEffort,
      codexSandboxMode: profile.codexSandboxMode,
      codexSpeed: profile.codexSpeed,
      origin: profile.origin ?? "device",
      runtime: profile.runtime,
      secretStored: profileSecretPlacement(profile),
      ...discoveredProviderStatus(id, profile, health),
      keySource: providerKey(profile).keySource,
    };
  });
}

/**
 * A provider found in the device's configuration is usable only once a turn
 * through its agent's SDK has passed (./provider-check.ts): an endpoint in a
 * file is not proof that it answers.
 */
function discoveredProviderStatus(
  id: string,
  profile: AgentProfileLocalConfig,
  health: ProviderHealth[],
): Pick<AgentProfileProjection, "status" | "statusDetail" | "check"> {
  if (profile.connectionType === "external" && !profileHasAuth(profile, health))
    return {
      status: "unavailable",
      statusDetail: "External connection helper is unavailable on this device.",
    };
  if (!needsProviderCheck(profile))
    return {
      status: profileStatus(profile, health),
      statusDetail: profileStatusDetail(profile, health),
    };
  const check = currentProviderCheck(id, profile, health);
  if (!check)
    return {
      status: "unavailable",
      statusDetail: "Checking that this provider answers.",
      check: { status: "pending" },
    };
  return check.status === "passed"
    ? {
        status: "healthy",
        check: { status: "passed", checkedAt: check.checkedAt },
      }
    : {
        status: "unavailable",
        statusDetail: check.message,
        check: {
          status: "failed",
          checkedAt: check.checkedAt,
          message: check.message,
        },
      };
}

/**
 * A server-owned definition dispatched with the session. It is authoritative:
 * the local profiles file is not consulted at all, so a profile that exists
 * only in the control plane still runs with its own endpoint, model and knobs.
 */
export function profileConfigFromDefinition(
  definition: ProfileDefinition,
): AgentProfileLocalConfig {
  return {
    baseUrl: definition.baseUrl?.trim() || undefined,
    claudeEffort: definition.claudeEffort,
    claudePermissionMode: definition.claudePermissionMode,
    codexApprovalPolicy: definition.codexApprovalPolicy,
    codexReasoningEffort: definition.codexReasoningEffort,
    codexSandboxMode: definition.codexSandboxMode,
    codexSpeed: definition.codexSpeed,
    connectionType: definition.connectionType,
    id: definition.id,
    label: definition.label,
    model: definition.model?.trim() || undefined,
    models: definition.models,
    contextWindows: definition.contextWindows,
    codexTransport: definition.codexTransport,
    codexTransportLearned: definition.codexTransportLearned,
    origin: "server",
    promptPrefix: definition.promptPrefix?.trim() || undefined,
    runtime: definition.runtime,
  };
}

export function profileConfigForSession(
  workspacePath: string,
  session: AgentSession,
  dispatched?: ProfileDefinition,
): AgentProfileLocalConfig {
  if (dispatched) {
    return profileConfigFromDefinition(dispatched);
  }
  const profiles = configuredAgentProfiles(workspacePath);
  if (session.profileId) {
    const byID = profiles.find(
      (profile) => profileID(profile) === session.profileId,
    );
    if (!byID) {
      // Never substitute another profile for a named one. The old fallback
      // reached for the same-runtime local login, which drops the endpoint —
      // a dispatched key would then go to the vendor's public API.
      throw new Error(
        `Agent profile "${session.profileId}" is not configured on this device and was not dispatched with the session.`,
      );
    }
    return byID;
  }
  const byFingerprint = session.profileFingerprint
    ? profiles.find(
        (profile) => profileFingerprint(profile) === session.profileFingerprint,
      )
    : undefined;
  if (byFingerprint) {
    return byFingerprint;
  }
  return (
    profiles.find((profile) => profile.runtime === session.provider) ??
    builtInProfile(session.provider)
  );
}

/**
 * A credential dispatched by the server replaces the local profile key for
 * this run only. The override feeds every downstream consumer of
 * profileRuntimeEnvironment, so server-held and locally-held credentials are
 * indistinguishable to the runtimes. The value never leaves process memory.
 */
export function withDispatchCredential(
  profile: AgentProfileLocalConfig,
  credential: string | undefined,
): AgentProfileLocalConfig {
  const key = credential?.trim();
  return key ? { ...profile, apiKey: key, origin: "server" } : profile;
}

/** The env var names a runtime reads its key from, most specific first. */
function credentialEnvNames(runtime: AgentProfileLocalConfig["runtime"]) {
  return runtime === "claude"
    ? ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_API_KEY"]
    : ["OPENAI_API_KEY", "CODEX_API_KEY"];
}

/**
 * The key an API provider's own configuration names, and its value on this
 * machine. Only that one source is read: Codex's `env_key`, a bearer token or
 * Authorization header in config.toml, `env.ANTHROPIC_AUTH_TOKEN` (or
 * `_API_KEY`) in Claude's settings, or the key in Foundry's profiles file and
 * that profile's own env block. Nothing else in the daemon's environment
 * stands in for it. A provider that names no key, authenticates with a login
 * or a command, or whose named key is empty here yields none.
 */
function providerKey(profile: AgentProfileLocalConfig): {
  keySource?: string;
  credential?: string;
} {
  if (
    profile.origin === "server" ||
    (profile.connectionType !== "openai_compatible" &&
      profile.connectionType !== "anthropic_compatible")
  )
    return {};
  if (profile.discovered) {
    const credential = profile.apiKey?.trim();
    return credential &&
      profile.keySource &&
      profile.keySource !== "none" &&
      profile.keyCheckable !== false
      ? { keySource: profile.keySource, credential }
      : {};
  }
  const fromFile = profile.apiKey?.trim();
  if (fromFile) return { keySource: "apiKey", credential: fromFile };
  for (const name of credentialEnvNames(profile.runtime)) {
    const credential = profile.env?.[name]?.trim();
    if (credential) return { keySource: `env.${name}`, credential };
  }
  return {};
}

/**
 * The key one configured API provider names, for the server's promote flow,
 * which asks only after the person confirmed copying it. The value goes to
 * the caller and is never logged.
 */
export function configuredProviderKey(profileId: string): {
  keySource?: string;
  credential?: string;
} {
  const id = profileId.trim();
  if (!id) {
    throw new Error("read_provider_key requires profileId");
  }
  const profile = configuredAgentProfiles("").find(
    (item) => profileID(item) === id,
  );
  if (!profile) {
    throw new Error(`Agent profile "${id}" is not configured on this device.`);
  }
  return providerKey(profile);
}

/**
 * The endpoint a run calls. The server corrects a base URL when it is saved;
 * one saved before that (a Claude base ending in `/v1`, a pasted
 * `/v1/messages`) is repaired here. A bare Codex host is left as saved: it
 * may answer without a version.
 */
function runBaseUrl(profile: AgentProfileLocalConfig): string {
  const raw = profile.baseUrl?.trim() ?? "";
  if (!raw) return "";
  const result = normalizeProviderBaseUrl(profile.runtime, raw, {
    addMissingVersion: false,
  });
  return "baseUrl" in result ? result.baseUrl : raw;
}

export function profileRuntimeEnvironment(
  profile: AgentProfileLocalConfig,
  session?: AgentSession,
): Record<string, string> {
  const env: Record<string, string> = { ...(profile.env ?? {}) };
  if (profile.runtime === "claude") {
    env.DISABLE_AUTOUPDATER = "1";
    // Foundry picks the account, endpoint and model. The person's settings
    // load natively, but may not route the session elsewhere (host mode).
    if (!profile.command?.trim())
      env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "1";
  }
  const model = session?.model?.trim() || profile.model?.trim();
  // A native login is not the daemon's inherited gateway configuration.
  // Empty values override inherited API keys, including in stage sandboxes.
  if (profile.connectionType === "local_login") {
    Object.assign(env, nativeLoginEnvironment(profile.runtime));
  }
  // A Codex provider run by name carries its own endpoint and credential.
  const ownEndpoint = profile.connectionType !== "local_login";
  if (ownEndpoint && profile.apiKey?.trim()) {
    if (profile.runtime === "claude") {
      env.ANTHROPIC_AUTH_TOKEN = profile.apiKey.trim();
    } else {
      env.OPENAI_API_KEY = profile.apiKey.trim();
    }
  }
  const baseUrl = ownEndpoint ? runBaseUrl(profile) : "";
  if (baseUrl) {
    if (profile.runtime === "claude") {
      env.ANTHROPIC_BASE_URL = baseUrl;
      env.ANTHROPIC_API_BASE_URL = baseUrl;
    } else {
      env.OPENAI_BASE_URL = baseUrl;
      env.OPENAI_API_BASE = baseUrl;
      env.CODEX_BASE_URL = baseUrl;
    }
  }
  if (model) {
    env.FOUNDRY_AGENT_MODEL = model;
    if (profile.runtime === "claude") {
      const runModel = claudeRunModel(profile, model);
      env.ANTHROPIC_MODEL = runModel;
      // A compatible endpoint's env may carry stale defaults (a different
      // model for Haiku/Sonnet/Opus), and operations like context compaction
      // use them — a mismatch causes unrecognized_model errors, so pin them to
      // the profile model. A native login keeps them unset: its catalog
      // offers CLI aliases such as "default" or "opus[1m]", and pinning the
      // defaults to an alias makes the CLI resolve names like "default[1m]".
      if (
        profile.connectionType !== "local_login" &&
        profile.connectionType !== "external"
      ) {
        env.ANTHROPIC_DEFAULT_OPUS_MODEL = runModel;
        env.ANTHROPIC_DEFAULT_SONNET_MODEL = runModel;
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL = runModel;
        env.CLAUDE_CODE_SUBAGENT_MODEL = runModel;
      }
    } else {
      env.OPENAI_MODEL = model;
      env.CODEX_MODEL = model;
    }
  }
  if (
    profile.runtime === "claude" &&
    profile.contextWindow &&
    profile.contextWindow.model === model
  )
    Object.assign(env, claudeContextWindowEnvironment(profile.contextWindow));
  if (profile.connectionType === "external")
    for (const name of Object.keys(env))
      if (
        name.startsWith("FOUNDRY_NATIVE_") ||
        [
          "CODEX_HOME",
          "CLAUDE_CONFIG_DIR",
          "CLAUDE_SECURESTORAGE_CONFIG_DIR",
        ].includes(name)
      )
        delete env[name];
  return profile.connectionType === "external"
    ? Object.fromEntries(
        Object.entries(externalConnectionBaseEnvironment(env)).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : env;
}

/**
 * A server-dispatched compatible profile is authoritative: it authenticates
 * with exactly the credential the control plane dispatched (possibly none, for
 * a keyless internal gateway). The daemon's own environment must never quietly
 * supply one — that would send the gateway a request authenticated as this
 * machine, and make a genuinely keyless connection look like it works. Local
 * logins retain their explicit native credential source; an env profile and
 * selected native provider env/header references admit only their named values.
 */
export function baseProcessEnvironment(
  profile: AgentProfileLocalConfig,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!profile.command) {
    const kept = new Set([
      "CODEX_HOME",
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_SECURESTORAGE_CONFIG_DIR",
      "CLAUDE_CODE_TMPDIR",
      ...(profile.connectionType === "env"
        ? credentialEnvNames(profile.runtime)
        : []),
      ...(typeof profile.codexProviderConfig?.env_key === "string"
        ? [profile.codexProviderConfig.env_key]
        : []),
      ...Object.values(
        (profile.codexProviderConfig?.env_http_headers ?? {}) as Record<
          string,
          string
        >,
      ),
      ...(profile.connectionType === "local_login" &&
      profile.runtime === "claude"
        ? ["CLAUDE_CODE_OAUTH_TOKEN"]
        : []),
    ]);
    for (const name of Object.keys(env))
      if (
        /^(?:CODEX_|CLAUDE_|CLAUDECODE$|ANTHROPIC_|OPENAI_)/.test(name) &&
        !kept.has(name)
      )
        delete env[name];
  }
  if (
    profile.origin === "server" &&
    (profile.connectionType === "anthropic_compatible" ||
      profile.connectionType === "openai_compatible")
  ) {
    for (const name of credentialEnvNames(profile.runtime)) {
      delete env[name];
    }
  }
  return env;
}

export function upsertAgentProfileConfig(
  input: UpsertAgentProfilePayload["profile"],
  workspacePath: string,
): AgentProfileProjection {
  const runtime = input.runtime === "codex" ? "codex" : "claude";
  const label = input.label.trim();
  if (!label) {
    throw new Error("agent profile label is required");
  }
  const configScope: AgentConfigScope = "device";
  const connectionType =
    input.connectionType ??
    (runtime === "claude" ? "anthropic_compatible" : "openai_compatible");
  const targetPath = deviceAgentProfilesPath;
  const current = readAgentProfilesFile(targetPath);
  const nextID = profileID({ id: input.id, label, runtime });
  const existing = (current.profiles ?? []).find(
    (item) => profileID(item) === nextID,
  );
  if (
    existing?.connectionType === "external" ||
    input.connectionType === "external"
  )
    throw new Error(
      "External connections must be configured on the device; remote edits are not supported.",
    );
  const profile: AgentProfileLocalConfig = {
    apiKey: existing?.apiKey,
    baseUrl: input.baseUrl?.trim() || undefined,
    claudeEffort: input.claudeEffort || undefined,
    claudePermissionMode: input.claudePermissionMode || undefined,
    codexApprovalPolicy: input.codexApprovalPolicy || undefined,
    codexReasoningEffort: input.codexReasoningEffort || undefined,
    codexSandboxMode: input.codexSandboxMode || undefined,
    codexSpeed: input.codexSpeed || undefined,
    contextWindows: input.contextWindows ?? existing?.contextWindows,
    command: existing?.command,
    externalConnection: existing?.externalConnection,
    connectionType,
    enabled: true,
    env: existing?.env,
    id: nextID,
    label,
    model: input.model?.trim() || undefined,
    promptPrefix: input.promptPrefix?.trim() || undefined,
    runtime,
  };
  const profiles = (current.profiles ?? []).filter(
    (item) => profileID(item) !== profile.id,
  );
  profiles.push(profile);
  writeAgentProfilesFile(targetPath, { profiles });

  const device = getDevice();
  const projection = agentProfilesForWorkspace(device, workspacePath).find(
    (item) => item.id === profile.id,
  );
  if (!projection) {
    throw new Error("agent profile was saved but could not be projected");
  }
  return projection;
}

export function profileConfigFromInput(
  input: UpsertAgentProfilePayload["profile"],
): AgentProfileLocalConfig {
  const runtime = input.runtime === "codex" ? "codex" : "claude";
  const current = readAgentProfilesFile(deviceAgentProfilesPath);
  const inputID = input.id?.trim();
  const fallbackID = profileID({
    id: input.id,
    label: input.label,
    runtime,
  });
  const existing =
    (current.profiles ?? []).find(
      (item) => inputID && profileID(item) === inputID,
    ) ??
    (current.profiles ?? []).find((item) => profileID(item) === fallbackID) ??
    (inputID === `${runtime}_local` ? builtInProfile(runtime) : undefined);
  const connectionType =
    input.connectionType ??
    existing?.connectionType ??
    (runtime === "claude" ? "anthropic_compatible" : "openai_compatible");

  return {
    ...existing,
    // The key the caller supplied (the server unseals it for a catalog read)
    // outranks whatever the local file holds.
    apiKey: input.apiKey?.trim() || existing?.apiKey,
    baseUrl: input.baseUrl?.trim() || existing?.baseUrl,
    claudeEffort: input.claudeEffort || existing?.claudeEffort,
    claudePermissionMode:
      input.claudePermissionMode || existing?.claudePermissionMode,
    codexApprovalPolicy:
      input.codexApprovalPolicy || existing?.codexApprovalPolicy,
    codexReasoningEffort:
      input.codexReasoningEffort || existing?.codexReasoningEffort,
    codexSandboxMode: input.codexSandboxMode || existing?.codexSandboxMode,
    codexSpeed: input.codexSpeed || existing?.codexSpeed,
    contextWindows: input.contextWindows ?? existing?.contextWindows,
    connectionType,
    id: inputID || existing?.id || fallbackID,
    label: input.label?.trim() || existing?.label,
    model: input.model?.trim() || existing?.model,
    promptPrefix: input.promptPrefix?.trim() || existing?.promptPrefix,
    runtime,
  };
}
