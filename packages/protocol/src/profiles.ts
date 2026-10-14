// Agent runtimes on a device: their health, native CLIs and accounts, and the
// profiles (device-discovered or server-owned) sessions run with.

export type WorkerRuntimeId = "claude" | "codex" | "mock";

export type ProviderStatus = "healthy" | "missing_auth" | "unavailable";
export type AgentConnectionType =
  | "local_login"
  | "env"
  | "anthropic_compatible"
  | "openai_compatible"
  | "custom_command";
export type AgentConfigScope = "workspace" | "device";
/**
 * Where the credential for a profile lives. `local` means the daemon's own
 * configuration on that machine; `server` means the control plane's sealed
 * secret store and the key is dispatched per run.
 */
export type SecretPlacement = "local" | "server";
/**
 * `device` profiles are discovered by a daemon on one machine and cannot move.
 * `server` profiles are control-plane records usable on any device they are
 * enabled for.
 */
export type ProfileOrigin = "device" | "server";
export type ProfileAuthMode = "official" | "custom";
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ClaudePermissionMode =
  "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan";
export type CodexReasoningEffort =
  "minimal" | "low" | "medium" | "high" | "xhigh";
export type CodexSandboxMode =
  "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy =
  "untrusted" | "on-failure" | "on-request" | "never";
export type CodexSpeed = "standard" | "fast";

export interface AgentModelOption {
  id: string;
  label?: string;
  /** The window the endpoint's own `/models` catalog reports for it. */
  contextWindow?: number;
}

export interface ProviderHealth {
  deviceId?: string;
  provider: Exclude<WorkerRuntimeId, "mock">;
  status: ProviderStatus;
  authMode: "env" | "local_config" | "missing";
  secretStored: SecretPlacement;
  /**
   * Which account the native CLI is signed in as, for telling several logins
   * apart. Identity only — never a token.
   */
  accountLabel?: string;
  statusDetail?: string;
  /** The device's own Claude Code / Codex program, which Foundry runs. */
  cli?: NativeCli;
  /**
   * Skills this agent ships itself. Sessions on this agent always have them,
   * besides the skills their workspace selected.
   */
  officialSkills?: OfficialSkill[];
}

/** A skill Claude Code or Codex ships itself. */
export interface OfficialSkill {
  name: string;
  description?: string;
}

/**
 * Foundry runs the device's Claude Code and Codex rather than shipping its own
 * copies: whether the program is there, its version against the minimum the
 * worker was built for, and the official commands to install or update it.
 */
export interface NativeCli {
  installed: boolean;
  version?: string;
  minimumVersion?: string;
  outdated?: boolean;
  installCommand?: string;
  updateCommand?: string;
}

/** What running the official installer for a device's program produced. */
export interface NativeCliInstallResult {
  runtime: "claude" | "codex";
  ok: boolean;
  command: string;
  log: string;
  cli?: NativeCli;
}

export interface NativeAccountInspection {
  runtime: "claude" | "codex";
  source: string;
  sources: string[];
  executionSource: string;
  checkedAt: string;
  status: "verified" | "local_login" | "not_signed_in" | "unavailable";
  accountLabel?: string;
  plan?: string;
  message: string;
  usage: NativeAccountUsage[];
}

export interface NativeAccountUsage {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
}

export interface AgentProfileCheck {
  status: "pending" | "passed" | "failed";
  checkedAt?: string;
  /** Why the check failed, in the agent's words. */
  message?: string;
}

export interface AgentProfileProjection {
  /** The account a local login is signed in as, when the CLI recorded one. */
  accountLabel?: string;
  id: string;
  deviceId: string;
  runtime: Exclude<WorkerRuntimeId, "mock">;
  label: string;
  fingerprint?: string;
  status: ProviderStatus;
  authMode: ProviderHealth["authMode"];
  secretStored: SecretPlacement;
  configScope: AgentConfigScope;
  configLabel: string;
  /** Where in that file it is defined, e.g. `model_providers.aiden`. */
  configSection?: string;
  /**
   * For a provider found in the device's agent configuration: whether a turn
   * through its agent's SDK answered. It is offered only once that passed.
   */
  check?: AgentProfileCheck;
  /**
   * The key this provider's own configuration names, by name only: a Codex
   * `env_key` such as `$LLM_GATEWAY_KEY`, or `env.ANTHROPIC_AUTH_TOKEN` in a
   * Claude settings file. Absent when it sends no key, or authenticates with
   * a login or a command, neither of which can be copied.
   */
  keySource?: string;
  connectionType: AgentConnectionType;
  model?: string;
  /** Models offered for this profile wherever a run is configured. */
  models?: string[];
  promptPrefix?: string;
  claudeEffort?: ClaudeEffort;
  claudePermissionMode?: ClaudePermissionMode;
  codexReasoningEffort?: CodexReasoningEffort;
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexSpeed?: CodexSpeed;
  baseUrl?: string;
  commandLabel?: string;
  serverCredential?: boolean;
  origin: ProfileOrigin;
  /**
   * Set on a device profile whose endpoint already exists as a server profile.
   * The device row stays visible — the machine really is configured this way —
   * but it cannot be promoted twice.
   */
  promotedProfileId?: string;
  lastSeenLabel: string;
  statusDetail?: string;
}

/**
 * A control-plane owned profile. Unlike `AgentProfileProjection` this is a
 * definition, not a per-device resolution: it has no `deviceId` and no status,
 * because reachability is a property of the device that runs it.
 *
 * Only remote endpoint profiles can live here. `local_login`, `custom_command`
 * and `env` profiles describe machine-local state and stay device-owned.
 */
export interface ProfileDefinition {
  id: string;
  runtime: Exclude<WorkerRuntimeId, "mock">;
  label: string;
  connectionType: AgentConnectionType;
  authMode: ProfileAuthMode;
  baseUrl?: string;
  model?: string;
  /**
   * The models this profile offers. `model` is the default; everything here is
   * selectable in chat and issue runs. Native discovery fills it where a CLI
   * can enumerate, and anything the user adds stays.
   */
  models?: string[];
  /**
   * The person's own context window per model id, in tokens. A model without
   * one runs with the window its endpoint reports, else the official model's,
   * else 1M (model-context.ts).
   */
  contextWindows?: Record<string, number>;
  promptPrefix?: string;
  claudeEffort?: ClaudeEffort;
  claudePermissionMode?: ClaudePermissionMode;
  codexReasoningEffort?: CodexReasoningEffort;
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexSpeed?: CodexSpeed;
  /** True when a credential is sealed in the server secret store. Never the key. */
  hasCredential: boolean;
  /** Account that owns this connection; empty only before an admin exists. */
  ownerUserId?: string;
  /** Set when it was promoted from a provider in a device's own configuration. */
  promotedFrom?: ProfilePromotionSource;
  updatedAtLabel: string;
}

/**
 * The device provider a server profile was promoted from. Promoting the same
 * provider again updates this profile instead of adding another.
 */
export interface ProfilePromotionSource {
  deviceId: string;
  /** The provider's id on that device, e.g. `codex_provider_gateway`. */
  profileId: string;
  /**
   * Its base URL is the device's own loopback address, which no other device
   * can reach, so it may run only on that device.
   */
  deviceBound?: boolean;
}

/** Which server profiles a device is allowed to run. */
export interface DeviceProfileBinding {
  deviceId: string;
  profileId: string;
  enabled: boolean;
}

/**
 * Create or update a server profile. `apiKey` is write-only: it is sealed on
 * arrival and never read back by any endpoint. Omitting it keeps the stored
 * credential; an explicit empty string is not a clear (use the clear action).
 */
export interface SaveProfileInput {
  id?: string;
  runtime: Exclude<WorkerRuntimeId, "mock">;
  label: string;
  authMode: ProfileAuthMode;
  connectionType: AgentConnectionType;
  baseUrl?: string;
  model?: string;
  promptPrefix?: string;
  claudeEffort?: ClaudeEffort;
  claudePermissionMode?: ClaudePermissionMode;
  codexReasoningEffort?: CodexReasoningEffort;
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexSpeed?: CodexSpeed;
  models?: string[];
  /** Replaces the stored per-model windows; omitted keeps them. */
  contextWindows?: Record<string, number>;
  apiKey?: string;
}

/** Set the enabled server profiles for one device. Replaces the whole set. */
export interface SetDeviceProfilesInput {
  deviceId: string;
  profileIds: string[];
}

/**
 * Promote an API provider from a device's own configuration into a server
 * profile, or update the one it was promoted into before. The device's
 * configuration is never modified.
 */
export interface PromoteProfileInput {
  deviceId: string;
  profileId: string;
  /**
   * Also copy the key the provider's configuration names (`keySource`): the
   * device reads that one value and the server seals it. It is never sent to
   * the browser. Without it no key is copied, and a key already sealed for
   * the profile stays.
   */
  copyKey?: boolean;
}

export interface AgentProjection {
  id: string;
  workspaceId: string;
  deviceId: string;
  deviceLabel: string;
  provider: Exclude<WorkerRuntimeId, "mock">;
  profileId?: string;
  profileFingerprint?: string;
  profileLabel?: string;
  connectionType?: AgentConnectionType;
  status: ProviderStatus;
  authMode: ProviderHealth["authMode"];
  secretStored: SecretPlacement;
  configScope: AgentConfigScope;
  configLabel: string;
  lastSeenLabel: string;
  statusDetail?: string;
}
