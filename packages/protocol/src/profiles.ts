// Agent runtimes on a device: their health, native CLIs and accounts, and the
// profiles (device-discovered or server-owned) sessions run with.
import type {
  AgentConnectionType,
  ClaudeEffort,
  ClaudePermissionMode,
  CodexApprovalPolicy,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexSpeed,
  CodexTransportMode,
  ProfileAuthMode,
  ProfileModelPrice,
  WorkerRuntimeId,
} from "./contract.gen.js";
export type {
  AgentConfigScope,
  AgentConnectionType,
  AgentModelOption,
  AgentProfileCheck,
  AgentProfileProjection,
  AgentProjection,
  AgentRuntimeUpdate,
  ClaudeEffort,
  ClaudePermissionMode,
  CodexApprovalPolicy,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexSpeed,
  CodexTransport,
  CodexTransportMode,
  CodexTransportObservation,
  ExecutionDefaultScope,
  ExecutionDefaultsView,
  ExecutionModelDefault,
  ModelNote,
  ModelNoteInput,
  ModelNotePage,
  NativeAccountHold,
  NativeAccountInspection,
  NativeAccountUsage,
  NativeCli,
  NativeCliInstallResult,
  NativeSignInAction,
  NativeSignInInput,
  NativeSignInReplyPayload,
  NativeSignInRequestPayload,
  NativeSignInStatus,
  NativeSignInStep,
  OfficialSkill,
  ProfileAuthMode,
  ProfileConnector,
  ProfileDefinition,
  ProfileModelPrice,
  ProfileOrigin,
  ProfilePromotionSource,
  ProviderHealth,
  ProviderStatus,
  SecretPlacement,
  WorkerRuntimeId,
} from "./contract.gen.js";

export const codexTransportModes: readonly CodexTransportMode[] = [
  "auto",
  "websocket",
  "https",
];

/** Days an observation stands before a session tries the WebSocket again. */
export const codexTransportObservationDays = 7;

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
  /** Replaces custom prices by model; omitted keeps them. */
  modelPrices?: Record<string, ProfileModelPrice>;
  /** Replaces the stored per-model windows; omitted keeps them. */
  contextWindows?: Record<string, number>;
  /** Codex compatible endpoints only; omitted is `auto`. */
  codexTransport?: CodexTransportMode;
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
