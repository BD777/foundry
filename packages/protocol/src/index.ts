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
export type { CronLanguage, ParsedCron } from "./cron.js";

export * from "./feishu.js";
export * from "./process-labels.js";

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
  /**
   * Set while its device, connected, does not serve the folder. Sessions and
   * history stay; adding the folder on the device again clears it.
   */
  unavailableOnDevice?: WorkspaceUnavailability;
}

/** Why a workspace cannot run on its device. */
export interface WorkspaceUnavailability {
  /** "not_served": the device's worker no longer lists the folder. */
  reason: "not_served";
  since: string;
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
  /** What the device offers sessions, detected by its worker at registration. */
  resources?: DeviceResource[];
  /** Protocol features its worker declared; an older worker declares none. */
  capabilities?: string[];
  /** The worker build it runs, reported at registration (0.5.7 and later). */
  worker?: DeviceWorker;
  /** The machine, reported at registration (0.5.7 and later). */
  system?: DeviceSystem;
  /** An update requested from Foundry that has not finished yet. */
  workerUpdate?: DeviceWorkerUpdate;
  /** The last time the device dropped; the server adds it to projections. */
  lastDisconnect?: DeviceDisconnect;
  /**
   * Changes when the device's scanned skills or the catalog change. Workspace
   * data leaves skill lists out; load them with `/api/device-skills` and
   * reload when this changes.
   */
  skillsVersion?: string;
}

export interface DeviceWorkerUpdate {
  startedAt: string;
  /** The version it brings. */
  version?: string;
  /** The version the device ran when the update started. */
  fromVersion?: string;
  /** The file on the device the update writes to. */
  log?: string;
  /** The update did not finish in time; it may be started again. */
  stalled?: boolean;
  /** What it is doing, from the server's probes; after a failure, the last step seen. */
  step?: WorkerUpdateStep;
  /** What the step waits on, such as a retry. */
  stepDetail?: string;
  /** Why the update failed; it may be started again. */
  failure?: string;
  failureCode?: WorkerUpdateFailureCode;
  /** The failed update command's exit status. */
  exitCode?: number;
  /** The end of the update's log on the device, redacted. */
  logTail?: string[];
}

export type WorkerUpdateStep =
  "starting" | "checking" | "downloading" | "installing" | "restarting";

/**
 * `exited`: the update command failed. `vanished`: it ended without
 * reporting. `not_back`: the worker did not reconnect after restarting.
 */
export type WorkerUpdateFailureCode = "exited" | "vanished" | "not_back";

/**
 * A stretch when the worker's event loop was blocked; a registration carries
 * the ones recorded since the previous one so the server can log them.
 */
export interface WorkerStall {
  /** When the loop came back. */
  at: string;
  /** How long the loop was blocked, in milliseconds. */
  lagMs: number;
  /** The worker's long-running activities active during the stall. */
  activities?: string[];
}

/**
 * One connection to the server as the worker saw it, reported at the next
 * registration so a dropped device can be explained.
 */
export interface WorkerConnectionReport {
  openedAt: string;
  closedAt: string;
  /** How long the connection lasted, in milliseconds. */
  durationMs: number;
  /**
   * Who ended it: "worker" when the worker gave up (nothing from the server
   * for too long), "server" when a close frame arrived, "network" when the
   * socket ended without one.
   */
  closedBy: "worker" | "server" | "network";
  closeCode?: number;
  closeReason?: string;
  /** The socket error, e.g. "ECONNRESET: read ECONNRESET". */
  error?: string;
  /** Milliseconds between the last frame from the server and the close. */
  sinceServerDataMs?: number;
  /** Milliseconds between the server's last ping and the close. */
  sinceServerPingMs?: number;
  bytesReceived?: number;
  bytesSent?: number;
  /** Proxy host from the environment, if one is set (not used by the socket). */
  proxy?: string;
  /** Worst event-loop delay during the connection, in milliseconds. */
  maxLagMs?: number;
}

/** How a diagnostic check came out; "info" only reports a fact. */
export type DiagnosticStatus = "ok" | "info" | "warn" | "error";

/**
 * One check a worker ran on itself. The id names the check (the web words
 * its title and advice); values carry what it found.
 */
export interface DiagnosticCheck {
  id: string;
  status: DiagnosticStatus;
  values?: Record<string, string | number | boolean>;
}

/** A worker's report on itself, run on request from the device page. */
export interface DeviceDiagnostics {
  generatedAt: string;
  workerVersion: string;
  checks: DiagnosticCheck[];
  /** The worker's last connections to the server, oldest first. */
  connections: WorkerConnectionReport[];
  /** The end of the worker's own logs, secrets removed. */
  logTail: string[];
}

/** A repair a person can ask a worker to make on itself. */
export type DeviceRepairAction =
  "forget-missing-workspaces" | "clear-skill-scan-cache" | "recheck-agents";

export interface DeviceRepairResult {
  action: DeviceRepairAction;
  /** What changed, e.g. the forgotten folders. */
  values?: Record<string, string | number | boolean>;
}

/** The last time a device dropped, from both ends. */
export interface DeviceDisconnect {
  at: string;
  /** Why the server ended or lost the connection. */
  serverReason?: string;
  /** The worker's own account, once it reconnected and reported it. */
  worker?: WorkerConnectionReport;
}

/** The machine a device is, as its worker reports it at registration. */
export interface DeviceSystem {
  hostname: string;
  /** "macOS", "Debian GNU/Linux", … */
  os: string;
  osVersion?: string;
  kernel?: string;
  arch: string;
  cpuModel?: string;
  cpuCount?: number;
  memoryBytes?: number;
  /** The account the worker runs as. */
  user?: string;
  nodeVersion?: string;
}

export interface DeviceWorker {
  version: string;
  /**
   * The command that checks and updates the worker on that machine, as typed
   * there (`~/.foundry/bin/foundry-worker`); absent for a worker run from a
   * source checkout, which updates with git.
   */
  command?: string;
}

/**
 * A capability already present on a device that sessions may use, such as an
 * installed browser. Foundry discovers resources; it never installs them.
 */
export interface DeviceResource {
  /** Unique on the device, e.g. `browser:google-chrome`. */
  id: string;
  kind: "browser" | "computer_use";
  name: string;
  /** Whether a session can use it right now. */
  available: boolean;
  /** Why it is unavailable, or what a session should know about it. */
  detail?: string;
  /** Kind-specific facts, e.g. a browser's executable `path`. */
  attributes?: Record<string, string>;
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
   * It carries its own key and calls an endpoint other machines can reach,
   * so copying it to the server makes it usable elsewhere.
   */
  shareable?: boolean;
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

/**
 * A file a session's own write tools changed, or its answer named, recorded
 * once per turn. Attribution comes from the agent's tool calls, never from
 * files that merely changed on disk while it ran.
 */
export interface SessionFileRecord {
  /** Absolute path on the device. */
  path: string;
  /** Relative to the workspace, when the file is inside it. */
  workspacePath?: string;
  /** "tool": a write tool changed it; "reference": only the answer names it. */
  origin: "tool" | "reference";
  op: "created" | "modified" | "deleted" | "referenced";
  /** Inside a Git work tree: listed under Changes, otherwise under Files. */
  inGitRepo: boolean;
  /** The input whose turn recorded it. */
  inputId?: string;
  /** "main", or the id of the subagent whose tool wrote it. */
  agent?: string;
  bytes?: number;
  /** Lines this turn's writes added and removed, once the turn ended. */
  added?: number;
  removed?: number;
  /** Lines added and removed since the session first wrote it. */
  totalAdded?: number;
  totalRemoved?: number;
}

/** A path an answer names that its device verified; linked in the text. */
export interface SessionFileReference {
  /** As it appears in the answer: a code span's content or a link target. */
  text: string;
  path: string;
  kind: "file" | "dir";
}

/** One of a session's recorded files, read from its device. */
export interface SessionFileRead {
  sessionId: string;
  path: string;
  workspacePath?: string;
  origin: "tool" | "reference";
  /** The file resolves inside the session's workspace. */
  insideWorkspace: boolean;
  /** text: `content`; image: `dataBase64` and `mimeType`; binary: size only. */
  kind: "text" | "image" | "binary" | "missing";
  content?: string;
  dataBase64?: string;
  mimeType?: string;
  truncated: boolean;
  bytes?: number;
  mtime?: string;
  /** Modified on the device after the turn that recorded it. */
  changedSinceRecorded: boolean;
}

/**
 * What a session's own writes changed in one file, read from its device.
 * "hook": the file as it was before the session's first write and after its
 * last (Claude), so concurrent edits to other files never show.
 * "git-snapshot": against a Git snapshot taken when the turn started (Codex),
 * which may include other edits to the same file.
 */
export interface SessionFileDiff {
  sessionId: string;
  path: string;
  workspacePath?: string;
  origin: "tool" | "reference";
  insideWorkspace: boolean;
  /** One turn's diff; absent: the whole session's. */
  inputId?: string;
  source: "hook" | "git-snapshot";
  /** Absent when the diff is unavailable, binary or too large. */
  before?: string;
  after?: string;
  /** empty: the session created it; beforeEdits / turnStart: see `source`. */
  beforeLabel: "empty" | "beforeEdits" | "turnStart";
  /** afterEdits: after the session's last write; deleted: it removed it. */
  afterLabel: "afterEdits" | "current" | "deleted";
  /** Something else also wrote the file while the session edited it. */
  mayIncludeOtherEdits: boolean;
  /** The file changed on the device after the session's last write. */
  changedSince: boolean;
  truncated: boolean;
  binary: boolean;
  tooLarge: boolean;
  /** noBaseline: no copy from before the session's edits was kept. */
  unavailable?: "noBaseline";
  /** Lines added and removed, when both sides are text. */
  added?: number;
  removed?: number;
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
  /** Programs the latest revision runs. */
  requires?: string[];
}

/** Whether a device has a program some library skill needs. */
export interface DeviceTool {
  deviceId: string;
  tool: string;
  available: boolean;
  checkedAt: string;
  /** The version Foundry installed on the device, if it did. */
  version?: string;
}

/** A git repository the skill library takes skills from. */
export interface SkillRepository {
  id: string;
  /** The https remote. */
  url: string;
  /** Short form, e.g. "github.com/anthropics/skills". */
  label: string;
  /** Branch or tag followed; absent follows the default branch. */
  ref?: string;
  /** Folder within the repository holding the skills. */
  subpath?: string;
  /** Commit last seen at ref. */
  commit?: string;
  checkedAt?: string;
  error?: string;
  createdAt: string;
  skills: SkillRepositorySkill[];
  /** "pick": chosen skills; "bundle": the whole repository as one unit.
   * Either way the skills move to new versions by themselves. */
  mode: "pick" | "bundle";
  /** A bundle's name, e.g. "feishu-cli". */
  name?: string;
  /** The release tag (or branch and short commit) its skills are on. */
  version?: string;
  /** A rolled-back repository stays on its version until resumed. */
  paused?: boolean;
  /** Applied versions, newest first. */
  versions?: SkillBundleVersion[];
  /** Programs a bundle's skills run, with where to get them. */
  tools?: SkillBundleTool[];
  /** Programs named when the bundle was followed, which its source does
   * not publish itself (e.g. a Python CLI on PyPI). */
  declaredTools?: SkillToolDeclaration[];
  /** Skill folders the repository held when last read; absent if unknown. */
  foundCount?: number;
  /** The repository's own description from its host. */
  description?: string;
  /**
   * The device that reads the repository with its own git and npm settings
   * and credentials, for a source the server cannot reach; absent means the
   * server reads it.
   */
  fetchDeviceId?: string;
  fetchDeviceName?: string;
  /** Whether that device is connected now. */
  fetchDeviceOnline?: boolean;
  /**
   * The npm registry (https) its npm package and npm tools come from;
   * absent is the public registry when the server reads it, and the
   * device's own npm settings when a device does.
   */
  registry?: string;
  /** A check waits for the fetch device to come back online. */
  checkWaiting?: boolean;
}

/** One version a bundle was updated or rolled back to. */
export interface SkillBundleVersion {
  seq: number;
  tag: string;
  commit: string;
  appliedAt: string;
  rolledBack?: boolean;
  added?: string[];
  changed?: string[];
  removed?: string[];
  /** Picked skills whose folder left the repository with this version;
   * the library keeps them at their last revision. */
  missing?: string[];
  members?: SkillBundleMember[];
  /** The programs this version needs; rolling back restores them. */
  tools?: SkillBundleTool[];
}

/** One skill of a bundle version. */
export interface SkillBundleMember {
  dir: string;
  skillId: string;
  name: string;
  revision: number;
}

/** A program a bundle needs, installable from its GitHub release. */
export interface SkillBundleTool {
  name: string;
  version: string;
  assets?: SkillToolAsset[];
  checksumsUrl?: string;
  /**
   * Where it installs from: absent (a GitHub release download), "npm" (the
   * npm package `package`) or "uv" (the Python package `package`, via uv).
   */
  source?: "npm" | "uv";
  package?: string;
  /**
   * Where an npm tool installs from: absent is the public registry, an
   * https URL that registry, "device" each device's own npm settings.
   */
  registry?: string;
  /** A step it needs after installing, run only when the person asks. */
  setup?: SkillToolSetup;
  /**
   * Arguments of the command a person runs once in a terminal on each
   * device after installing (e.g. ["auth", "login"]); Foundry only shows it.
   */
  signIn?: string[];
}

/**
 * A program a bundle declares that its source does not publish: "uv"
 * installs the PyPI package `package`, "npm" the npm package `package`
 * (from the repository's registry), which provides `command`. Its version
 * follows the bundle's when the package has it, else its latest.
 */
export interface SkillToolDeclaration {
  source: "uv" | "npm";
  package: string;
  command: string;
}

/** Runs one of the installed package's commands with fixed arguments. */
export interface SkillToolSetup {
  /** A command the package installs; absent is the tool itself. */
  command?: string;
  args: string[];
  /** What it does, e.g. "Downloads Chrome for Testing". */
  description: string;
}

/** One platform's download of a tool. */
export interface SkillToolAsset {
  os: string;
  arch: string;
  name: string;
  url: string;
}

/** A bundle as workspaces choose it. */
export interface SkillBundleSummary {
  id: string;
  name: string;
  label: string;
  version?: string;
  /** The library skills it delivers now. */
  skillIds: string[];
}

/** A library skill taken from a repository folder. */
export interface SkillRepositorySkill {
  skillId: string;
  dir: string;
  /** Repository commit the skill's latest revision came from. */
  commit: string;
  /** The skill's name in the library. */
  name?: string;
  /** The skill left its bundle; sessions no longer get it. */
  retired?: boolean;
  /** A picked skill's folder is gone from the repository; the library
   * keeps its last revision. */
  missing?: boolean;
}

/** A skill folder found in a repository. */
export interface RepositorySkillFolder {
  dir: string;
  name: string;
  description: string;
  license?: string;
  /** Set when the folder is already in the library. */
  skillId?: string;
}

export interface SkillRepositoryView {
  repository: SkillRepository;
  available: RepositorySkillFolder[];
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
  /** Holds the workspace at one revision; absent or 0 follows the latest. */
  pinnedRevision?: number;
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

/**
 * Work the session's agent left running in the background: a command, a
 * monitor, a workflow, or a background subagent (shown under Subagents).
 * Only Claude reports background work; Codex's SDK ends everything with the
 * turn. Session events carry no command line: members read it, redacted,
 * with the task's output.
 */
export interface AgentBackgroundTask {
  id: string;
  provider: "claude" | "codex";
  kind: "command" | "monitor" | "workflow" | "subagent" | "other";
  description: string;
  /** Redacted command line, only in members' output reads. */
  command?: string;
  /** "ended": it is gone, and the agent did not say how it ended. */
  status: "running" | "completed" | "failed" | "stopped" | "ended";
  exitCode?: number;
  /** "user": stopped from Foundry; "agent_exit": its agent process ended. */
  stopReason?: "user" | "agent_exit";
  startedAt: string;
  endedAt?: string;
  /** The deadline the agent gave it (monitors), when it has one. */
  timeLimitMs?: number;
  /** The background subagent that started it. */
  ownerSubagentTaskId?: string;
  toolUseId?: string;
  /** The agent's redacted one-line summary of how it ended. */
  summary?: string;
  /** Whether the task writes an output log the device can show. */
  hasOutput: boolean;
}

/** The last 64 KB of a background task's output, for members. */
export interface AgentBackgroundTaskOutput {
  sessionId: string;
  taskId: string;
  /** Redacted command line, when the task ran one. */
  command?: string;
  /** Plain text: ANSI escapes stripped, secrets redacted. */
  content: string;
  /** True when earlier output was left out. */
  truncated: boolean;
  bytes: number;
  /** "missing": no output was written, or it was cleaned up. */
  kind: "text" | "binary" | "missing";
}

export interface AgentSessionEventMetadata {
  /** A Claude background task's own output log, on its end event. */
  taskOutputFile?: string;
  /**
   * The session's background work at the time of the event (latest wins):
   * running tasks and the most recent finished ones.
   */
  backgroundTaskSnapshot?: AgentBackgroundTask[];
  /** A file the session's tools wrote or its answer named, once per turn. */
  sessionFile?: SessionFileRecord;
  /** Paths the turn's answer names that the device verified (turn end). */
  fileReferences?: SessionFileReference[];
  prompt?: string;
  subagentType?: string;
  taskId?: string;
  taskType?: string;
  toolUseId?: string;
  /** Authoritative timer snapshot for the session at the time of the event. */
  timerSnapshot?: AgentScheduledTask[];
  /** Present on events marking an automatic timer-triggered background turn. */
  timerFire?: AgentSessionTimerFire;
  /** Present on the event that ends a turn the provider reported usage for. */
  turnUsage?: AgentTurnUsage;
  /** What a Claude subagent has used so far, on its progress and end events. */
  subagentUsage?: SubagentUsage;
  /**
   * A model request's final tokens (Claude), reported when its stream ends.
   * Steps of that request share the id; the event itself is not shown.
   */
  requestUsage?: ModelRequestUsage;
}

/**
 * A subagent's own work as Claude reports it: one token total, without an
 * input/output split. Not part of its parent's per-step token counts.
 */
export interface SubagentUsage {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

/**
 * What one turn cost, as the agent's SDK reported it. Token counts share one
 * meaning across providers: `inputTokens` is every prompt token the model
 * read, and cache reads/writes are parts of it, not additions to it.
 */
export interface AgentTurnUsage {
  /** Wall time from the runtime taking the turn to its final result. */
  durationMs: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Includes `reasoningTokens` when the provider reports them. */
  outputTokens: number;
  reasoningTokens?: number;
  /** Model requests in the turn (Claude reports them; Codex does not). */
  modelRequests?: number;
}

export interface AgentSubagentTranscriptMessage {
  content: string;
  id: string;
  role: "user" | "assistant" | "tool";
  title?: string;
  kind?: TranscriptMessage["kind"];
  callId?: string;
  status?: TranscriptMessage["status"];
  /** Tokens of the subagent's model request behind this step. */
  requestUsage?: ModelRequestUsage;
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
  usage?: SubagentUsage;
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
  usage?: SubagentUsage;
}

export interface ChatAttachment {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
}

/**
 * One message delivered to a session: the unit of dispatch. It is not a
 * session of its own; identity, permissions and lineage stay with the session.
 */
export interface SessionInput {
  id: string;
  prompt: string;
  attachments?: ChatAttachment[];
  profileTransitionNote?: string;
  importedContext?: string;
  /** When the server received it; its transcript events carry the same time. */
  at?: string;
}

/** Label of the transcript event each session input writes. */
export const sessionInputEventLabel = "User message";

/**
 * One native agent session (a Claude Code or Codex session) for its whole
 * life. Conversation turns stay inside the native agent.
 */
export interface AgentSession {
  /** Account that started it; agent-created sessions inherit their parent's. */
  createdByUserId?: string;
  id: string;
  /** Equals `id`; kept so readers of legacy per-turn rows still group them. */
  threadId?: string;
  /**
   * The native session it resumes on the runtime it runs on; absent starts
   * one there. The server owns which native sessions a session has.
   */
  nativeSessionId?: string;
  /**
   * Set until a fork first answers: `nativeSessionId` starts as a copy of
   * this native session (Claude's forkSession).
   */
  forkNativeSessionId?: string;
  workspaceId: string;
  agentId: string;
  deviceId: string;
  provider: Exclude<WorkerRuntimeId, "mock">;
  profileId?: string;
  profileFingerprint?: string;
  profileLabel?: string;
  source?:
    "chat" | "diagnostic" | "naming" | "verification" | "agent" | "issue";
  /**
   * The job the session does for Foundry; absent for a chat. An
   * issue_execution session implements its Issue; an issue_clarification
   * session talks the Issue through with the person, read-only.
   */
  role?: "issue_execution" | "issue_clarification";
  /** Orchestration lineage: the session that created this one. A record, not a permission. */
  parentSessionId?: string;
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
  /** The session's opening goal. */
  prompt: string;
  /** The latest input; `status` describes handling it. */
  input?: SessionInput;
  /**
   * Server-resolved workspace skill selection for this session. The runtime
   * is forced to expose only these; an empty present list means none.
   */
  skillRefs?: SessionSkillRef[];
  /** The answer to the latest input. */
  response?: string;
  error?: string;
  startedAt?: string;
  lastActivityAt?: string;
  /**
   * Last conversation activity: the latest input, or the answer that
   * completed it. Chat lists order by it.
   */
  activityAt?: string;
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
  /** Where a person's message came from when not the web, such as "feishu". */
  via?: string;
}

/** The Issue's clarification session and the person's latest message to it. */
export interface IssueClarification {
  sessionId: string;
  /** "replying" while the Agent answers, "failed" when it could not, "answered" once recorded. */
  status: "replying" | "failed" | "answered";
  error?: string;
  inputId: string;
  messageId: string;
  /** The draft the message was about. */
  revision: number;
  contentDigest: string;
  changeReason: string;
}

/**
 * What an Issue's execution asked the person: a decision (input) or an
 * approval (permission). The Issue blocks on it once the execution's turn
 * ends and resumes in its candidate with the answer.
 */
export interface IssueQuestion {
  id: string;
  kind: "input" | "permission";
  text: string;
  /** Suggested answers; the person may answer otherwise. */
  options?: string[];
  /** The execution session that asked. */
  runId: string;
  askedAt: string;
}

/** What a clarification input is about, sent with the session. */
export interface ClarificationTurn {
  draft: import("./evidence.js").IssueContract;
  /** The conversation before this message, for a session without native context. */
  messages: ChatRecapMessage[];
  message: string;
}

/** A clarification session's reply to one message. */
export interface ClarificationResponse {
  message: string;
  proposedContent?: import("./evidence.js").ContractContent;
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
  clarification?: IssueClarification;
  question?: IssueQuestion;
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
  /** Files that travelled with a user message. */
  attachments?: ChatAttachment[];
  /** Tokens of the model request that produced this step (Claude). */
  requestUsage?: ModelRequestUsage;
  /** On the answer that ended a turn: the turn's usage, read from the agent's own log. */
  turnUsage?: AgentTurnUsage;
}

/**
 * One model request's tokens. A request can produce several steps; each
 * carries the same id, and its last report counts.
 */
export interface ModelRequestUsage {
  requestId: string;
  /** Prompt tokens, cache reads and writes included. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
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

/** The composer's choices when a message was queued; it is sent with them. */
export interface ChatQueueRunSettings {
  agentId?: string;
  provider?: string;
  profileId?: string;
  model?: string;
  claudeEffort?: string;
  claudePermissionMode?: string;
  codexReasoningEffort?: string;
  codexSandboxMode?: string;
  codexApprovalPolicy?: string;
  codexSpeed?: string;
  profileTransitionNote?: string;
}

export type ChatQueueItemState = "queued" | "dispatching" | "sent" | "failed";

/**
 * A message queued in a chat. The server sends it as the chat's next input
 * once the chat's session is idle; a failed one holds the queue.
 */
export interface ChatQueueItem {
  id: string;
  chatId: string;
  position: number;
  text: string;
  attachments?: ChatAttachment[];
  runSettings: ChatQueueRunSettings;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  state: ChatQueueItemState;
  error?: string;
  sentSessionId?: string;
}

/** A chat's unsent messages in sending order; revision grows with each change. */
export interface ChatQueue {
  workspaceId: string;
  chatId: string;
  revision: number;
  items: ChatQueueItem[];
}

export interface EnqueueChatMessageInput {
  text: string;
  attachments?: ChatAttachment[];
  runSettings: ChatQueueRunSettings;
}

export interface EditChatQueueItemInput {
  text?: string;
  attachments?: ChatAttachment[];
  runSettings?: ChatQueueRunSettings;
  expectedRevision: number;
}

export interface ReorderChatQueueInput {
  itemIds: string[];
  expectedRevision: number;
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
  /** Legacy; lists label `updatedAt` themselves, workers no longer send it. */
  updatedLabel?: string;
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

/**
 * A skill Foundry itself gives an agent runtime, beside the skills the agent
 * ships and the ones a workspace selects.
 */
export interface BuiltinSkill {
  runtime: Exclude<WorkerRuntimeId, "mock">;
  name: string;
  description?: string;
  /** Where it comes from, e.g. "Anthropic skills". */
  source: string;
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
  devices: DeviceProjection[];
  issues: Issue[];
  profiles: ProfileDefinition[];
  promotedSkills: PromotedSkill[];
  /** Skills Foundry itself gives an agent; sessions on it always have them. */
  builtinSkills?: BuiltinSkill[];
  providerHealth: ProviderHealth[];
  skills: SkillPackRef[];
  workspace: WorkspaceProjection;
  workspaceFiles: WorkspaceFileEntry[];
  workspaceSkillBindings: WorkspaceSkillBinding[];
  /** Library skills the workspace gets from its owner's defaults. */
  defaultSkillIds?: string[];
  /** Skills it gets from defaults or bundles, including ones turned off. */
  inheritedSkillIds?: string[];
  /** Inherited skills this workspace turned off. */
  offSkillIds?: string[];
  /** Which programs library skills need the visible devices have. */
  deviceTools?: DeviceTool[];
  /** The library's bundles, and the ones this workspace uses. */
  skillBundles?: SkillBundleSummary[];
  workspaceBundleIds?: string[];
  /** Its owner's default bundles; workspaceBundleIds holds those still on. */
  defaultBundleIds?: string[];
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
  /**
   * create: a new library skill; reuse: the identical library entry; update:
   * this device's version becomes the entry's next revision; keep: the
   * library entry stays as it is and nothing is published; fork: a new
   * library skill under another name.
   */
  action: "create" | "reuse" | "update" | "keep" | "fork";
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

/**
 * The npm package that installs a worker: `npx -y <name>@latest install`.
 * The web shows its commands; the worker installs and updates itself from it.
 */
export const workerPackageName = "@bd777/foundry-worker";

/**
 * Where a server's worker comes from (`GET /api/worker/release`): package
 * tarballs the server serves itself, at server-relative URLs, or the npm
 * registry. Workers install and update from it; the web shows commands for it.
 */
export type WorkerRelease =
  | { source: "npm" }
  | {
      source: "server";
      version: string;
      /**
       * `url` names this exact build (workers install from it); `latestUrl`
       * always serves the current one, so commands naming it stay valid.
       */
      packages: { name: string; url: string; latestUrl: string }[];
    };
