export type WorkerRuntimeId = "claude" | "codex" | "mock";

export {
  ProtocolValidationError,
  parseProtocolEnvelope,
  parseProtocolEnvelopeJSON,
} from "./validation.js";
export type { ProtocolEnvelope } from "./validation.js";

export { daemonMessageTypes, isDaemonMessageType } from "./daemon-messages.js";
export type { DaemonMessageType } from "./daemon-messages.js";

export { humanizeCron, nextCronFire, parseCron } from "./cron.js";
export type { ParsedCron } from "./cron.js";

export * from "./feishu.js";

export type IssueStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "verifying"
  | "accepted"
  | "abandoned";

export interface IssueBlockedReason {
  kind: "needs_input" | "needs_permission" | "system_error";
  message: string;
}

export type IssueReadiness =
  "ready" | "split" | "proposal" | "direction" | "unsuitable" | "inferring";

export type RunStatus =
  "queued" | "running" | "blocked" | "completed" | "failed" | "canceled";

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
export type ProfileAuthorizationStatus =
  "waiting_for_user" | "completed" | "failed";
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
}

export interface ProfileAuthorization {
  id: string;
  profileId: string;
  runtime: Exclude<WorkerRuntimeId, "mock">;
  status: ProfileAuthorizationStatus;
  url?: string;
  code?: string;
  message?: string;
}

export interface StartProfileAuthorizationInput {
  deviceId: string;
}

export interface CompleteProfileAuthorizationInput {
  authorizationResult?: string;
}

export interface WorkspaceProjection {
  id: string;
  name: string;
  localPath: string;
  baseline: string;
  contextSummary: string;
  acceptedCount: number;
  resolvedCount: number;
  deviceId?: string;
  deviceLabel?: string;
  /** The caller's role in this workspace. */
  accessRole?: WorkspaceAccessRole;
}

export type WorkspaceAccessRole = "viewer" | "member" | "maintainer" | "owner";

export interface DeviceProjection {
  id: string;
  label: string;
  /**
   * "removed" is a server-side soft-removal tombstone projection. The device
   * row (and all history) is retained, but the UI hides it from the available
   * device list and the server refuses its daemon's (re)registration.
   */
  status: "connected" | "disconnected" | "removed";
  lastSeenLabel: string;
  runtimeSettings?: AgentRuntimeSettings;
  /** Whether the caller owns, and so may manage, this device. */
  owned?: boolean;
}

export interface AgentRuntimeSettings {
  activeRuntimeTtlMs: number;
  maxConcurrentTasks: number;
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
  updatedAtLabel: string;
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
  apiKey?: string;
}

/** Set the enabled server profiles for one device. Replaces the whole set. */
export interface SetDeviceProfilesInput {
  deviceId: string;
  profileIds: string[];
}

/**
 * Promote a daemon-discovered device profile into a server profile. The key
 * this machine holds always moves with it: a promoted profile without a
 * credential is unusable on every device, including the one it came from.
 */
export interface PromoteProfileInput {
  deviceId: string;
  profileId: string;
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

export interface WorkspaceFileEntry {
  id: string;
  workspaceId: string;
  path: string;
  name: string;
  kind: "file" | "directory";
  sizeLabel: string;
  updatedLabel: string;
}

export interface WorkspaceFileRead {
  workspaceId: string;
  path: string;
  content: string;
  truncated: boolean;
}

export interface WorkspaceDirectoryEntry {
  id: string;
  name: string;
  path: string;
}

export interface WorkspaceTreeEntry {
  id: string;
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  extension?: string;
}

export interface SkillPackRef {
  id: string;
  name: string;
  scope?: "workspace" | "issue" | "available";
  source?: string;
  version: string;
  workspaceId?: string;
}

/**
 * Workspace skill isolation model.
 *
 * Flow is one-directional: a device scans its local roots, a skill is
 * promoted (uploaded) to the server catalog, and a workspace selects entries
 * from that catalog. Runtimes only ever see the workspace selection.
 */

/** A scan root configured on one device. Default roots live on the server. */
export interface DeviceSkillRoot {
  deviceId: string;
  path: string;
  isDefault: boolean;
}

/** One local skill observed by a device scan. */
export type SkillDependencyStrength = "required" | "related";

export interface SkillDependency {
  skillName: string;
  strength: SkillDependencyStrength;
  evidence: string;
  status?: "resolved" | "missing" | "ambiguous";
  targetRoot?: string;
  targetDirName?: string;
}

export interface DeviceSkill {
  manifest?: SkillFileInfo[];
  serverState?:
    | "unpublished"
    | "in_sync"
    | "different"
    | "reusable"
    | "name_conflict"
    | "unknown";
  serverRevision?: number;
  serverCandidates?: PromotedSkill[];
  deviceId: string;
  root: string;
  dirName: string;
  name: string;
  description: string;
  sizeBytes: number;
  mtimeLabel: string;
  /** Set once this exact entry has been promoted to the server catalog. */
  promotedSkillId?: string;
  /** Other installed skills this one references, inferred statically. */
  dependencies?: SkillDependency[];
  dependencyAnalysisError?: string;
  dependenciesAnalyzed?: boolean;
  /** SHA-256 of the complete source tree used to build this graph node. */
  sourceDigest?: string;
}

/** A server catalog entry; content lives in immutable revisions. */
export interface PromotedSkill {
  sourceDigest?: string;
  usedByWorkspaces?: string[];
  id: string;
  name: string;
  description: string;
  originDeviceId: string;
  originDeviceLabel: string;
  originRoot: string;
  originDirName: string;
  latestRevision: number;
  createdLabel: string;
  updatedLabel: string;
  dependencies?: SkillDependency[];
  dependencyAnalysisError?: string;
}

/** A resolved (skill, revision) pair attached to a dispatched session. */
export interface SessionSkillRef {
  skillId: string;
  revision: number;
  name: string;
  checksum: string;
  byteSize: number;
}

/** One row of a workspace's selection from the server skill catalog. */
export interface WorkspaceSkillBinding {
  workspaceId: string;
  skillId: string;
}

export interface RunEvent {
  id: string;
  runId: string;
  at: string;
  label: string;
  detail: string;
  level: "info" | "warning" | "error";
}

export interface AcceptanceArtifact {
  id: string;
  issueId: string;
  kind: "text" | "preview" | "diff" | "report";
  title: string;
  summary: string;
  primaryUri?: string;
}

export interface Run {
  id: string;
  issueId: string;
  workspaceId?: string;
  status: RunStatus;
  runtime: WorkerRuntimeId;
  startedLabel: string;
  startedAt?: string;
  completedAt?: string;
  environmentId?: string;
  environmentRevision?: number;
  executionCwd?: string;
  error?: string;
  events: RunEvent[];
}

export interface AgentSessionEvent {
  id: string;
  sessionId: string;
  at: string;
  label: string;
  detail: string;
  level: "info" | "warning" | "error";
  metadata?: AgentSessionEventMetadata;
  message?: TranscriptMessage;
}

/**
 * A timer/scheduled task an agent created inside its own session.
 *
 * Claude exposes session-scoped cron jobs (CronCreate/ScheduleWakeup); they
 * live only while the agent process stays alive. Codex headless sessions have
 * no equivalent, so timers never appear for Codex threads.
 */
export interface AgentScheduledTask {
  id: string;
  kind: "cron" | "wakeup";
  /** Raw 5-field cron expression in local time. */
  schedule: string;
  /** Human-readable, already localized schedule description. */
  humanSchedule: string;
  /** false for one-shot reminders, true for recurring jobs. */
  recurring: boolean;
  /** Prompt submitted to the agent when the timer fires. */
  prompt: string;
  /** Next computed fire time (ISO 8601), when still computable. */
  nextFireAt?: string;
}

/** One automatic, timer-driven turn that ran without a Foundry turn open. */
export interface AgentSessionTimerFire {
  /** Scheduled task id when the firing task could be correlated. */
  id?: string;
  origin: "scheduled" | "background";
  prompt: string;
  response?: string;
  startedAt?: string;
  completedAt: string;
}

export interface AgentSessionEventMetadata {
  outputFile?: string;
  prompt?: string;
  subagentType?: string;
  taskId?: string;
  taskType?: string;
  toolUseId?: string;
  /** Authoritative timer snapshot for the session at the time of the event. */
  timerSnapshot?: AgentScheduledTask[];
  /** Present on events marking an automatic timer-triggered background turn. */
  timerFire?: AgentSessionTimerFire;
}

export interface AgentSubagentTranscriptMessage {
  content: string;
  id: string;
  role: "user" | "assistant" | "tool";
  title?: string;
  kind?: TranscriptMessage["kind"];
  callId?: string;
  status?: TranscriptMessage["status"];
}

export interface AgentSubagentTranscript {
  messages: AgentSubagentTranscriptMessage[];
  prompt?: string;
  sessionId: string;
  status: "running" | "completed" | "failed";
  subagentType?: string;
  taskId: string;
  title: string;
  toolUseId: string;
}

export interface AgentSubagentSummary {
  prompt?: string;
  responseTexts: string[];
  sessionId: string;
  status: "running" | "completed" | "failed";
  subagentType?: string;
  taskId: string;
  title: string;
  toolUseId: string;
}

export interface ChatAttachment {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
}

export interface AgentSession {
  /** Account that started it; agent-created sessions inherit their parent's. */
  createdByUserId?: string;
  id: string;
  threadId?: string;
  nativeSessionId?: string;
  workspaceId: string;
  agentId: string;
  deviceId: string;
  provider: Exclude<WorkerRuntimeId, "mock">;
  profileId?: string;
  profileFingerprint?: string;
  profileLabel?: string;
  source?: "chat" | "diagnostic" | "naming" | "verification" | "agent";
  /** Orchestration lineage: the agent session that created this one. */
  parentSessionId?: string;
  /** Human-confirmed supervising session; birth lineage never changes. */
  supervisorSessionId?: string;
  /** When set, the session executes inside an Issue candidate worktree. */
  issueId?: string;
  /** Present for the active status "blocked" (rate limit / permission wait). */
  blockedReason?: string;
  /** source=naming job targeting an orchestration group to rename. */
  groupNameTarget?: string;
  /** Set when this session caused a new orchestration group to be created. */
  createdGroupId?: string;
  model?: string;
  claudeEffort?: ClaudeEffort;
  claudePermissionMode?: ClaudePermissionMode;
  codexReasoningEffort?: CodexReasoningEffort;
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexSpeed?: CodexSpeed;
  status: RunStatus;
  title: string;
  prompt: string;
  attachments?: ChatAttachment[];
  profileTransitionNote?: string;
  importedContext?: string;
  /**
   * Server-resolved workspace skill selection for this session. The runtime
   * is forced to expose only these; an empty present list means none.
   */
  skillRefs?: SessionSkillRef[];
  response?: string;
  error?: string;
  startedAt?: string;
  lastActivityAt?: string;
  completedAt?: string;
  createdLabel: string;
  answerRevision?: string;
  updatedLabel: string;
  events?: AgentSessionEvent[];
}

export interface IssueConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  runId?: string;
  createdAt: string;
}

export interface Issue {
  /** Account that started it; agent-created sessions inherit their parent's. */
  createdByUserId?: string;
  /** Dispatch-only confirmed content; never authored by the execution Agent. */
  executionContract?: import("./evidence.js").IssueContract;
  contractState?:
    "draft" | "confirmed" | "amendment_pending" | "legacy_unconfirmed";
  currentContractRevision?: number;
  draftContractRevision?: number;
  currentCandidateSnapshotId?: string;
  currentReviewSnapshotId?: string;
  verificationSummary?: import("./evidence.js").VerificationSummary;
  blockedReason?: IssueBlockedReason;
  codexSpeed?: CodexSpeed;
  model?: string;
  profileId?: string;
  claudeEffort?: ClaudeEffort;
  codexReasoningEffort?: CodexReasoningEffort;
  messages?: IssueConversationMessage[];
  id: string;
  workspaceId?: string;
  shortId: string;
  title: string;
  status: IssueStatus;
  priority: "none" | "low" | "medium" | "high";
  readiness?: IssueReadiness;
  sourceInput: string;
  inferredTask: string;
  runtime: WorkerRuntimeId;
  skills: SkillPackRef[];
  acceptanceCriteria: string[];
  checks: string[];
  artifact?: AcceptanceArtifact;
  run?: Run;
  updatedLabel: string;
}

export interface ChatRecapMessage {
  role: "user" | "assistant";
  text: string;
}

/** Display records retain native semantics independently of handoff prose. */
export interface TranscriptMessage {
  id: string;
  at?: string;
  kind:
    | "user"
    | "assistant"
    | "reasoning"
    | "commentary"
    | "tool"
    | "context"
    | "boundary"
    | "status"
    | "failure";
  text: string;
  title?: string;
  callId?: string;
  status?: "running" | "completed" | "failed";
}

export interface ChatLayoutGroup {
  id: string;
  name: string;
}

export interface ChatPlacement {
  chatId: string;
  groupId: string;
}

// Array order defines group order and the order of chats within each container.
// An empty groupId denotes the ungrouped list.
export interface ChatLayout {
  revision: number;
  groups: ChatLayoutGroup[];
  positions: ChatPlacement[];
}

export interface ChatThread {
  id: string;
  updatedAt?: string;
  workspaceId?: string;
  provider?: Exclude<WorkerRuntimeId, "mock">;
  profileId?: string;
  profileFingerprint?: string;
  profileLabel?: string;
  nativeSessionId?: string;
  title: string;
  preview: string;
  handoffContext?: string;
  transcript?: TranscriptMessage[];
  answerRevision?: string;
  recentMessages?: ChatRecapMessage[];
  status?: RunStatus;
  readonly: boolean;
  updatedLabel: string;
}

export interface AssetProjection {
  id: string;
  workspaceId?: string;
  name: string;
  kind:
    "worktree_pool" | "preview_ports" | "artifact_archive" | "provider_auth";
  status: "available" | "leased" | "missing" | "blocked";
  detail: string;
}

export interface FoundryDataProjection {
  runs?: Run[];
  agentProfiles: AgentProfileProjection[];
  agents: AgentProjection[];
  agentSessions: AgentSession[];
  assets: AssetProjection[];
  chats: ChatThread[];
  deviceProfiles: DeviceProfileBinding[];
  deviceSkillRoots: DeviceSkillRoot[];
  deviceSkills: DeviceSkill[];
  devices: DeviceProjection[];
  issues: Issue[];
  profiles: ProfileDefinition[];
  promotedSkills: PromotedSkill[];
  providerHealth: ProviderHealth[];
  skills: SkillPackRef[];
  workspace: WorkspaceProjection;
  workspaceFiles: WorkspaceFileEntry[];
  workspaceSkillBindings: WorkspaceSkillBinding[];
  workspaces: WorkspaceProjection[];
}

export const fixtureWorkspace: WorkspaceProjection = {
  id: "ws_atlas",
  name: "Atlas Web",
  localPath: "/Users/you/workspaces/atlas",
  baseline: "main",
  contextSummary:
    "Workspace context is authoritative. Skill packs carry reusable technique. Workers run locally and do not remember.",
  acceptedCount: 128,
  resolvedCount: 42,
};

export const fixtureDevice: DeviceProjection = {
  id: "dev_mbp",
  label: "MacBook Pro M4",
  status: "connected",
  lastSeenLabel: "online",
};

export const fixtureProviderHealth: ProviderHealth[] = [
  {
    provider: "claude",
    status: "healthy",
    authMode: "env",
    secretStored: "local",
  },
  {
    provider: "codex",
    status: "healthy",
    authMode: "local_config",
    secretStored: "local",
  },
];

export const fixtureIssues: Issue[] = [
  {
    id: "iss_112",
    shortId: "ISS-112",
    title: "Clarify which build is actually live",
    status: "pending",
    priority: "none",
    readiness: "direction",
    sourceInput:
      'Pasted feedback: "I could not tell which build was actually live."',
    inferredTask:
      'Pasted feedback: "I could not tell which build was actually live."',
    runtime: "mock",
    skills: [
      { id: "issue-splitting", name: "issue-splitting", version: "1.0" },
    ],
    acceptanceCriteria: ["Clarify the feedback before production starts."],
    checks: ["Needs human direction"],
    updatedLabel: "Updated 40m",
  },
  {
    id: "iss_110",
    shortId: "ISS-110",
    title: "iOS simulator validation for the mobile shell",
    status: "pending",
    priority: "low",
    readiness: "unsuitable",
    sourceInput:
      "Try iOS simulator validation for the mobile shell before acceptance.",
    inferredTask:
      "Try iOS simulator validation for the mobile shell before acceptance.",
    runtime: "mock",
    skills: [],
    acceptanceCriteria: [
      "Confirm the iOS simulator asset exists before dispatch.",
    ],
    checks: ["Requires iOS Simulator asset"],
    updatedLabel: "Updated 1h",
  },
  {
    id: "iss_108",
    shortId: "ISS-108",
    title: "Explain that secrets stay local on setup",
    status: "pending",
    priority: "medium",
    readiness: "ready",
    sourceInput:
      "The provider setup page should explain that secrets stay on the device.",
    inferredTask:
      "The provider setup page should explain that secrets stay on the device.",
    runtime: "claude",
    skills: [
      { id: "issue-splitting", name: "issue-splitting", version: "1.0" },
    ],
    acceptanceCriteria: ["Setup copy states that credentials stay local."],
    checks: ["Ready to execute"],
    updatedLabel: "Updated 18m",
  },
  {
    id: "iss_107",
    shortId: "ISS-107",
    title: "Declutter the dashboard top-right cluster",
    status: "pending",
    priority: "medium",
    readiness: "split",
    sourceInput:
      "Circled the crowded cluster in the top-right of the dashboard.",
    inferredTask:
      "Circled the crowded cluster in the top-right of the dashboard.",
    runtime: "codex",
    skills: [
      { id: "issue-splitting", name: "issue-splitting", version: "1.0" },
    ],
    acceptanceCriteria: [
      "Split the visual cleanup into executable sub-issues.",
    ],
    checks: ["Needs split"],
    updatedLabel: "Updated 25m",
  },
  {
    id: "iss_105",
    shortId: "ISS-105",
    title: "Add baseline comparison to the review view",
    status: "verifying",
    priority: "high",
    sourceInput: "Add a baseline comparison panel to the review surface.",
    inferredTask:
      "Add a baseline-vs-candidate comparison panel to the review surface, reusing the local preview host with changed-region highlighting.",
    runtime: "codex",
    skills: [
      {
        id: "baseline-comparison",
        name: "baseline-comparison",
        version: "1.2",
      },
      { id: "visual-qa", name: "visual-qa", version: "0.9" },
    ],
    acceptanceCriteria: [
      "Review state exposes one primary acceptance artifact.",
      "Baseline and candidate metadata are visible.",
      "Accept and request-changes actions are present.",
    ],
    checks: ["Typecheck passed", "Visual smoke passed", "A11y contrast passed"],
    artifact: {
      id: "art_105",
      issueId: "iss_105",
      kind: "preview",
      title: "Local Vite preview",
      summary: "Candidate worktree wt-3 compared against baseline main.",
    },
    run: {
      id: "run_2411",
      issueId: "iss_105",
      status: "completed",
      runtime: "codex",
      startedLabel: "2m ago",
      events: [
        {
          id: "evt_1",
          runId: "run_2411",
          at: "2m ago",
          label: "Loaded workspace context",
          detail: "AGENTS.md, CONTEXT.md, and installed skills",
          level: "info",
        },
        {
          id: "evt_2",
          runId: "run_2411",
          at: "90s ago",
          label: "Produced acceptance artifact",
          detail: "Local preview and comparison notes",
          level: "info",
        },
      ],
    },
    updatedLabel: "Updated 8m",
  },
  {
    id: "iss_104",
    shortId: "ISS-104",
    title: "Calm down workspace home density",
    status: "in_progress",
    priority: "high",
    sourceInput:
      "The dashboard first screen feels busy. Make it calmer and move run logs behind details.",
    inferredTask:
      "Reduce visual density on the landing surface and move run logs behind progressive disclosure, keeping review and baseline prominent.",
    runtime: "claude",
    skills: [
      { id: "shadcn-ui-cleanup", name: "shadcn-ui-cleanup", version: "0.4" },
    ],
    acceptanceCriteria: [
      "Workspace home keeps input and review surfaces prominent.",
      "Run logs are progressively disclosed.",
      "Layout remains scan-friendly.",
    ],
    checks: ["Typecheck running", "Visual QA queued"],
    run: {
      id: "run_2418",
      issueId: "iss_104",
      status: "running",
      runtime: "claude",
      startedLabel: "45s ago",
      events: [
        {
          id: "evt_2418_1",
          runId: "run_2418",
          at: "2m 14s",
          label: "Dispatched to MacBook Pro M4",
          detail: "worktree wt-3 allocated",
          level: "info",
        },
        {
          id: "evt_2418_2",
          runId: "run_2418",
          at: "2m 06s",
          label: "Claude started",
          detail: "loaded AGENTS.md + workspace context",
          level: "info",
        },
        {
          id: "evt_2418_3",
          runId: "run_2418",
          at: "1m 40s",
          label: "Edited src/workspace/Home.tsx",
          detail: "reduced density, moved logs behind details",
          level: "info",
        },
        {
          id: "evt_2418_4",
          runId: "run_2418",
          at: "1m 02s",
          label: "Permission requested - pnpm typecheck",
          detail: "granted by workspace policy",
          level: "info",
        },
        {
          id: "evt_2418_5",
          runId: "run_2418",
          at: "0m 44s",
          label: "Typecheck passed",
          detail: "0 errors reported",
          level: "info",
        },
        {
          id: "evt_2418_6",
          runId: "run_2418",
          at: "now",
          label: "Building review preview",
          detail: "vite build -> local preview",
          level: "info",
        },
      ],
    },
    updatedLabel: "Updated 2m",
  },
  {
    id: "iss_106",
    shortId: "ISS-106",
    title: "Extract shared status chip component",
    status: "in_progress",
    priority: "medium",
    sourceInput: "Reuse one status chip across acceptance, runs, and issues.",
    inferredTask:
      "Extract the shared status chip surface so issue cards, run rows, and acceptance panels render one consistent state language.",
    runtime: "codex",
    skills: [
      { id: "shadcn-ui-cleanup", name: "shadcn-ui-cleanup", version: "0.4" },
    ],
    acceptanceCriteria: [
      "Status tone, dot, and label rendering come from one component.",
      "Issue, run, and review states keep matching colors.",
      "No page-specific chip styling duplicates remain.",
    ],
    checks: ["Component extraction running", "Visual QA queued"],
    run: {
      id: "run_2417",
      issueId: "iss_106",
      status: "running",
      runtime: "codex",
      startedLabel: "46s ago",
      events: [
        {
          id: "evt_4",
          runId: "run_2417",
          at: "46s ago",
          label: "Editing shared component",
          detail: "Normalizing issue, run, and acceptance chip states",
          level: "info",
        },
      ],
    },
    updatedLabel: "Updated 46s",
  },
  {
    id: "iss_118",
    shortId: "ISS-118",
    title: "Tighten run timeline row spacing",
    status: "verifying",
    priority: "medium",
    sourceInput: "Row spacing on the run timeline feels loose — tighten it.",
    inferredTask:
      "Tighten vertical spacing on run-timeline rows without breaking the existing hierarchy.",
    runtime: "claude",
    skills: [{ id: "visual-qa", name: "visual-qa", version: "0.9" }],
    acceptanceCriteria: [
      "Run timeline rows are denser while retaining hierarchy.",
    ],
    checks: ["1 check needs attention"],
    artifact: {
      id: "art_118",
      issueId: "iss_118",
      kind: "preview",
      title: "Timeline spacing preview",
      summary: "Candidate run timeline spacing compared against the baseline.",
    },
    updatedLabel: "Updated 31m",
  },
  {
    id: "iss_201",
    shortId: "ISS-201",
    title: "Provider settings copy",
    status: "accepted",
    priority: "low",
    sourceInput:
      "Rewrite provider settings to emphasize that secrets stay local.",
    inferredTask:
      "Rewrite provider settings to emphasize that secrets stay local.",
    runtime: "claude",
    skills: [
      {
        id: "web-preview-acceptance",
        name: "web-preview-acceptance",
        version: "2.0",
      },
    ],
    acceptanceCriteria: [
      "Provider settings copy emphasizes local credentials.",
    ],
    checks: ["Baseline updated"],
    updatedLabel: "Updated 12m",
  },
  {
    id: "iss_098",
    shortId: "ISS-098",
    title: "Compact run timeline",
    status: "accepted",
    priority: "medium",
    sourceInput: "Denser run timeline rows for scanning.",
    inferredTask: "Denser run timeline rows for scanning.",
    runtime: "codex",
    skills: [
      {
        id: "web-preview-acceptance",
        name: "web-preview-acceptance",
        version: "2.0",
      },
    ],
    acceptanceCriteria: ["Run timeline rows scan more densely."],
    checks: ["Baseline updated"],
    updatedLabel: "Updated 3h",
  },
];

export const fixtureChats: ChatThread[] = [
  {
    id: "c1",
    title: "Does the workspace have its own context?",
    preview: "workspace vs. chat context",
    readonly: false,
    updatedLabel: "2d",
  },
  {
    id: "c2",
    title: "Brainstorm: a calmer landing surface",
    preview: "ideas for density + disclosure",
    readonly: false,
    updatedLabel: "3d",
  },
  {
    id: "c3",
    title: "Where should baseline compare live?",
    preview: "review surface vs. runs",
    readonly: false,
    updatedLabel: "5d",
  },
];

export const fixtureAssets: AssetProjection[] = [
  {
    id: "asset_worktrees",
    name: "Worktree pool",
    kind: "worktree_pool",
    status: "available",
    detail: "2 active · 4 available",
  },
  {
    id: "asset_archive",
    name: "Artifact archive",
    kind: "artifact_archive",
    status: "available",
    detail: "128 accepted increments",
  },
  {
    id: "asset_ports",
    name: "Preview ports",
    kind: "preview_ports",
    status: "available",
    detail: "4200–4210 · local",
  },
];
export * from "./evidence.js";
export * from "./evidence-validation.js";
export * from "./evidence-rpc.js";

/** Reviewed device-local transitive promotion closure. */
export interface SkillPromotionPlan {
  digest: string;
  skills: DeviceSkill[];
  problems: string[];
  related: SkillDependency[];
}

export interface SkillFileInfo {
  path: string;
  digest: string;
  sizeBytes: number;
  binary: boolean;
}
export interface SkillPromotionResolution {
  root: string;
  dirName: string;
  action: "create" | "reuse" | "update" | "fork";
  targetSkillId?: string;
  expectedRevision?: number;
  name?: string;
}
export interface SkillComparisonInput {
  deviceId: string;
  root: string;
  dirName: string;
  skillId: string;
  revision: number;
  sourceDigest: string;
  path?: string;
  side?: "local" | "server";
}
export interface SkillFileChange {
  path: string;
  kind: "added" | "removed" | "modified";
  before?: SkillFileInfo;
  after?: SkillFileInfo;
}
export interface SkillComparison {
  files: SkillFileChange[];
  unchanged: number;
  revision: number;
}
export interface SkillFileComparison {
  before: string;
  after: string;
  unavailable?: string;
}
