/**
 * Agent profile management — local config, runtime environment, and status.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  AgentConfigScope,
  AgentConnectionType,
  AgentProfileProjection,
  AgentProjection,
  AgentSession,
  DeviceProjection,
  ProfileDefinition,
  ProfileOrigin,
  ProviderHealth,
  SecretPlacement,
} from "@foundry/protocol";
import { hardenPrivateFile, writeJSON } from "./storage.js";
import { readOptionalText, safeID, yamlScalar } from "./utils.js";
import { getDevice } from "./device.js";
import { nativeAgentProfiles } from "./native-agent-config.js";
import { nativeLoginHealth } from "./native-login.js";
import { nativeLoginEnvironment } from "./native-login-environment.js";
import { providerHealthData } from "./provider-health.js";
import { sessionAmbientEnvironment } from "./session-ambient.js";
import {
  projectedProfileAuthMode,
  projectedProfileStatusDetail,
} from "./agent-profile-state.js";

// --- Types ---

export interface AgentProfileLocalConfig {
  apiKey?: string;
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

export interface UpsertAgentProfilePayload {
  profile: {
    /**
     * Write-only: supplied for a catalog read so the endpoint can be asked with
     * the same key a run would use. Never persisted by this payload.
     */
    apiKey?: string;
    baseUrl?: string;
    claudeEffort?: AgentProfileProjection["claudeEffort"];
    claudePermissionMode?: AgentProfileProjection["claudePermissionMode"];
    codexApprovalPolicy?: AgentProfileProjection["codexApprovalPolicy"];
    codexReasoningEffort?: AgentProfileProjection["codexReasoningEffort"];
    codexSandboxMode?: AgentProfileProjection["codexSandboxMode"];
    codexSpeed?: AgentProfileProjection["codexSpeed"];
    configScope?: AgentConfigScope;
    connectionType?: AgentConnectionType;
    deviceId?: string;
    id?: string;
    label: string;
    model?: string;
    promptPrefix?: string;
    runtime: string;
    workspaceId?: string;
  };
}

// --- Constants ---

export const deviceAgentProfilesPath = resolve(
  homedir(),
  ".foundry",
  "agent-profiles.local.json",
);

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
    "baseUrl" | "command" | "connectionType" | "runtime"
  >,
): string {
  const runtime = profile.runtime;
  const connectionType = profile.connectionType ?? "local_login";
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
      connectionType: profile.connectionType ?? "custom_command",
      deviceId: device.id,
      fingerprint: profileFingerprint(profile),
      label:
        profile.label?.trim() ||
        (profile.runtime === "codex" ? "Codex" : "Claude"),
      lastSeenLabel: device.lastSeenLabel,
      model: profile.model,
      models: profile.models,
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
      status: profileStatus(profile, health),
      statusDetail: profileStatusDetail(profile, health),
    };
  });
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
 * The api key this machine actually authenticates with for one profile, for
 * the server's promote flow. The profiles file is only the first source: a
 * profile can leave `apiKey` empty and rely on its own env block or on the
 * daemon's environment, and that key is the one its runs really use, so
 * promotion has to carry it too. An empty string means the profile has no key
 * at all — the normal case for local login and command profiles — which is not
 * an error here. The value is returned to the caller and never logged.
 */
export function localProfileCredential(profileId: string): string {
  const id = profileId.trim();
  if (!id) {
    throw new Error("read_profile_credential requires profileId");
  }
  const profile = configuredAgentProfiles("").find(
    (item) => profileID(item) === id,
  );
  if (!profile) {
    throw new Error(`Agent profile "${id}" is not configured on this device.`);
  }
  const fromFile = profile.apiKey?.trim();
  if (fromFile) {
    return fromFile;
  }
  const env = profile.env ?? {};
  for (const name of credentialEnvNames(profile.runtime)) {
    const value = env[name]?.trim() || process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return "";
}

export function profileRuntimeEnvironment(
  profile: AgentProfileLocalConfig,
  session?: AgentSession,
): Record<string, string> {
  const env: Record<string, string> = { ...(profile.env ?? {}) };
  const model = session?.model?.trim() || profile.model?.trim();
  // A native login is not the daemon's inherited gateway configuration.
  // Empty values override inherited API keys, including in stage sandboxes.
  if (profile.connectionType === "local_login") {
    Object.assign(env, nativeLoginEnvironment(profile.runtime));
  }
  if (profile.connectionType !== "local_login" && profile.apiKey?.trim()) {
    if (profile.runtime === "claude") {
      env.ANTHROPIC_AUTH_TOKEN = profile.apiKey.trim();
    } else {
      env.OPENAI_API_KEY = profile.apiKey.trim();
    }
  }
  if (profile.connectionType !== "local_login" && profile.baseUrl?.trim()) {
    if (profile.runtime === "claude") {
      env.ANTHROPIC_BASE_URL = profile.baseUrl.trim();
      env.ANTHROPIC_API_BASE_URL = profile.baseUrl.trim();
    } else {
      env.OPENAI_BASE_URL = profile.baseUrl.trim();
      env.OPENAI_API_BASE = profile.baseUrl.trim();
      env.CODEX_BASE_URL = profile.baseUrl.trim();
    }
  }
  if (model) {
    env.FOUNDRY_AGENT_MODEL = model;
    if (profile.runtime === "claude") {
      env.ANTHROPIC_MODEL = model;
      // A compatible endpoint's env may carry stale defaults (a different
      // model for Haiku/Sonnet/Opus), and operations like context compaction
      // use them — a mismatch causes unrecognized_model errors, so pin them to
      // the profile model. A native login keeps them unset: its catalog
      // offers CLI aliases such as "default" or "opus[1m]", and pinning the
      // defaults to an alias makes the CLI resolve names like "default[1m]".
      if (profile.connectionType !== "local_login") {
        env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
        env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
        env.CLAUDE_CODE_SUBAGENT_MODEL = model;
      }
    } else {
      env.OPENAI_MODEL = model;
      env.CODEX_MODEL = model;
    }
  }
  return env;
}

/**
 * A server-dispatched compatible profile is authoritative: it authenticates
 * with exactly the credential the control plane dispatched (possibly none, for
 * a keyless internal gateway). The daemon's own environment must never quietly
 * supply one — that would send the gateway a request authenticated as this
 * machine, and make a genuinely keyless connection look like it works. Local
 * logins and device-owned profiles are untouched: for them an inherited env
 * var is a configured credential source (see profileHasAuth).
 */
function baseProcessEnvironment(
  profile: AgentProfileLocalConfig,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
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

export function sessionEnvironment(
  workspacePath: string,
  profile: AgentProfileLocalConfig,
  session?: AgentSession,
): NodeJS.ProcessEnv {
  return {
    ...baseProcessEnvironment(profile),
    ...profileRuntimeEnvironment(profile, session),
    ...sessionAmbientEnvironment(session?.id),
    FOUNDRY_ATTACHMENTS_JSON: JSON.stringify(session?.attachments ?? []),
    FOUNDRY_AGENT_PROFILE: profileID(profile),
    FOUNDRY_AGENT_PROFILE_LABEL: profile.label ?? profileID(profile),
    FOUNDRY_WORKSPACE: workspacePath,
    FOUNDRY_SESSION_ID: session?.id ?? process.env.FOUNDRY_SESSION_ID ?? "",
    FOUNDRY_SESSION_SOURCE:
      session?.source ?? process.env.FOUNDRY_SESSION_SOURCE ?? "chat",
  };
}

export function sessionAttachmentContext(session: AgentSession): string {
  const attachments = session.attachments ?? [];
  if (attachments.length === 0) {
    return "";
  }
  const lines = attachments.map((attachment, index) => {
    const label = attachment.kind === "image" ? "image" : "file";
    const mime = attachment.mimeType ? ` (${attachment.mimeType})` : "";
    const path = attachment.path.trim();
    const tag =
      attachment.kind === "image"
        ? `\n<image name="${attachment.name}" path="${path}"></image>`
        : "";
    return `${index + 1}. ${label}: ${attachment.name}${mime}\n   path: ${path}${tag}`;
  });
  return [
    "Attached files for this turn are available on the local filesystem. Use the paths below as the source of truth.",
    ...lines,
  ].join("\n");
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
  const profile: AgentProfileLocalConfig = {
    apiKey: existing?.apiKey,
    baseUrl: input.baseUrl?.trim() || undefined,
    claudeEffort: input.claudeEffort || undefined,
    claudePermissionMode: input.claudePermissionMode || undefined,
    codexApprovalPolicy: input.codexApprovalPolicy || undefined,
    codexReasoningEffort: input.codexReasoningEffort || undefined,
    codexSandboxMode: input.codexSandboxMode || undefined,
    codexSpeed: input.codexSpeed || undefined,
    command: existing?.command,
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
    connectionType,
    id: inputID || existing?.id || fallbackID,
    label: input.label?.trim() || existing?.label,
    model: input.model?.trim() || existing?.model,
    promptPrefix: input.promptPrefix?.trim() || existing?.promptPrefix,
    runtime,
  };
}
