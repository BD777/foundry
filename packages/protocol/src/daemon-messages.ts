import type { NativeArchiveItem, NativeArchiveResult } from "./chat.js";
// Canonical daemon WebSocket message vocabulary. Every envelope `type` that
// crosses the server <-> daemon socket is named here exactly once, so the
// TypeScript worker never spells a wire literal by hand.
//
// The Go side keeps its own `ws*Type` constants in
// apps/server/internal/httpapi/daemon_wire.go. `scripts/audit-contract.mjs`
// mechanically compares the two sets; it checks the vocabulary, not payload
// shapes or direction.
//
// The payload interfaces below are the requests the server sends a worker.
// The same audit compares each one's JSON field names with its Go struct:
// `ws<Name>` in apps/server/internal/httpapi, unless its name map says
// otherwise. Keep them flat (no inline object types, no `extends`) so the
// audit can read them.

import type { ChatAttachment, TranscriptMessage } from "./chat.js";
import type { AgentRuntimeSettings, DeviceRepairAction } from "./device.js";
import type { ExternalAccountMaterial } from "./external-accounts.js";
import type { DeviceConnectorUse } from "./connectors.js";
import type { ClarificationTurn, Issue } from "./issue.js";
import type {
  AgentConfigScope,
  AgentConnectionType,
  AgentProfileProjection,
  ProfileDefinition,
} from "./profiles.js";
import type { SessionSkillRef } from "./skills.js";
import type { AgentSession } from "./session.js";

export const daemonMessageTypes = {
  serviceTunnelOpen: "service_tunnel_open",
  listServiceListeners: "list_service_listeners",
  serviceListenersListed: "service_listeners_listed",
  ack: "ack",
  agentModelsListed: "agent_models_listed",
  agentProfileUpserted: "agent_profile_upserted",
  attachmentChunkRead: "attachment_chunk_read",
  attachmentRead: "attachment_read",
  attachmentWrite: "attachment_write",
  attachmentWritten: "attachment_written",
  agentRuntimeSettingsUpserted: "agent_runtime_settings_upserted",
  cancelSession: "cancel_session",
  /** Server tells: who else uses this device's system account (device-sharing.ts). */
  deviceSharing: "device_sharing",
  directoriesListed: "directories_listed",
  inspectWorkspace: "inspect_workspace",
  inspectNativeAccount: "inspect_native_account",
  nativeAccountInspected: "native_account_inspected",
  installNativeCli: "install_native_cli",
  nativeCliInstalled: "native_cli_installed",
  workspaceInspected: "workspace_inspected",
  error: "error",
  fileRead: "file_read",
  /** Device answers: a file outside the workspaces (device-files.ts). */
  deviceFileRead: "device_file_read",
  contextPatch: "context_patch",
  contextPatched: "context_patched",
  knowledgeCommand: "knowledge_command",
  knowledgeResult: "knowledge_result",
  forgetWorkspace: "forget_workspace",
  /** Server asks: folders near a missing workspace's that look like it. */
  findMovedWorkspace: "find_moved_workspace",
  movedWorkspaceFound: "moved_workspace_found",
  heartbeat: "heartbeat",
  hello: "hello",
  issueEnvironment: "issue_environment",
  issueEnvironmentResult: "issue_environment_result",
  issueEnvironmentChanged: "issue_environment_changed",
  evidenceRequest: "evidence_request",
  evidenceResult: "evidence_result",
  listAgentModels: "list_agent_models",
  listDirectories: "list_directories",
  listSubagents: "list_subagents",
  listWorkspaceTree: "list_workspace_tree",
  readFile: "read_file",
  /** Server asks, for the device's owner: a file outside the workspaces. */
  readDeviceFile: "read_device_file",
  /** Server asks: the key one provider's own configuration names. */
  readProviderKey: "read_provider_key",
  /** Server asks: run the explicit check of one external connection (uses quota). */
  checkExternalConnection: "check_external_connection",
  externalConnectionChecked: "external_connection_checked",
  /** Server asks: remove one external connection from the device. */
  removeExternalConnection: "remove_external_connection",
  externalConnectionRemoved: "external_connection_removed",
  /** Server asks: an external connection's setup on the device, live. */
  readExternalConnectionSetup: "read_external_connection_setup",
  externalConnectionSetupRead: "external_connection_setup_read",
  /** Server asks: run a connection's registered setup command (remote commands on). */
  startExternalConnectionSetup: "start_external_connection_setup",
  externalConnectionSetupStarted: "external_connection_setup_started",
  cancelExternalConnectionSetup: "cancel_external_connection_setup",
  externalConnectionSetupCancelled: "external_connection_setup_cancelled",
  providerKeyRead: "provider_key_read",
  readSkillFile: "read_skill_file",
  skillFileRead: "skill_file_read",
  refreshWorkspaceSkills: "refresh_workspace_skills",
  workspaceSkillsRefreshed: "workspace_skills_refreshed",
  readSkillContent: "read_skill_content",
  readSubagentTranscript: "read_subagent_transcript",
  /** Server asks: the part of a native chat's log before a byte offset. */
  readNativeHistory: "read_native_history",
  nativeArchive: "native_archive",
  nativeArchiveResult: "native_archive_result",
  readSessionUsage: "read_session_usage",
  readSessionFile: "read_session_file",
  sessionFileRead: "session_file_read",
  readSessionFileDiff: "read_session_file_diff",
  sessionFileDiffRead: "session_file_diff_read",
  readBackgroundTaskOutput: "read_background_task_output",
  backgroundTaskOutputRead: "background_task_output_read",
  backgroundTaskOutputChanged: "background_task_output_changed",
  stopBackgroundTask: "stop_background_task",
  backgroundTaskStopped: "background_task_stopped",
  readyForIssue: "ready_for_issue",
  refreshResources: "refresh_resources",
  resourcesRefreshed: "resources_refreshed",
  /**
   * Worker news, unasked: its whole resource inventory (ResourcesReport),
   * sent only to a server that announced resources_v1.
   */
  resourcesReport: "resources_report",
  /**
   * One operation on a resource a session holds a lease on
   * (ResourceOperateRequest), answered with resource_operated
   * (ResourceOperateResult). Only to a worker that declared
   * resources_ops_v1.
   */
  resourceOperate: "resource_operate",
  resourceOperated: "resource_operated",
  /**
   * Fences a resource at a generation (ResourceResetRequest): operations of
   * older leases are refused, their provider sessions reset and closed.
   * Answered with resource_reset_done (ResourceResetResult).
   */
  resourceReset: "resource_reset",
  resourceResetDone: "resource_reset_done",
  /**
   * Installs a resource backend the person chose to install on this device
   * (ResourceBackendInstallRequest), answered with
   * resource_backend_installed (ResourceBackendInstallResult).
   */
  installResourceBackend: "install_resource_backend",
  resourceBackendInstalled: "resource_backend_installed",
  /**
   * The device owner's resource settings for this device
   * (ResourceSourceSettings): sent when they change and after hello, only
   * to a worker that declared resources_compute_v1, which keeps them and
   * enforces them itself. Answered with resource_settings_applied (the
   * settings the worker now enforces).
   */
  resourceSettings: "resource_settings",
  resourceSettingsApplied: "resource_settings_applied",
  recoverSession: "recover_session",
  registered: "registered",
  /**
   * The server's answer to a registration (hello or workspace_ready) that
   * left out sections it does not have (RegistrationNeededPayload): the
   * registration was not taken; send it again in full.
   */
  registrationNeeded: "registration_needed",
  /** A piece of a large envelope a worker sends in pieces (reply_chunk). */
  replyChunk: "reply_chunk",
  runSession: "run_session",
  scanSkills: "scan_skills",
  prepareSkills: "prepare_skills",
  sessionCanceled: "session_canceled",
  sessionBlocked: "session_blocked",
  sessionResumed: "session_resumed",
  sessionCompleted: "session_completed",
  sessionEvent: "session_event",
  sessionNativeSessionId: "session_native_session_id",
  sessionStarted: "session_started",
  /**
   * Worker news (SessionTurnPayload): a session's agent started or ended a
   * model turn of its own, one the session's status does not show (a
   * timer's, or its follow-up after background work).
   */
  sessionTurn: "session_turn",
  sessionSteered: "session_steered",
  sessionUsageRead: "session_usage_read",
  skillContentRead: "skill_content_read",
  setupWorkspace: "setup_workspace",
  /** Server asks: serve this workspace (same id) from another folder. */
  relinkWorkspace: "relink_workspace",
  workspaceRelinked: "workspace_relinked",
  steerSession: "steer_session",
  subagentTranscriptRead: "subagent_transcript_read",
  nativeHistoryRead: "native_history_read",
  subagentsListed: "subagents_listed",
  skillsScanned: "skills_scanned",
  upsertAgentProfile: "upsert_agent_profile",
  upsertAgentRuntimeSettings: "upsert_agent_runtime_settings",
  updateWorker: "update_worker",
  workerUpdateStarted: "worker_update_started",
  readWorkerUpdateStatus: "read_worker_update_status",
  workerUpdateStatus: "worker_update_status",
  /** Worker news (DeviceRunner): its session runner, whenever it changes. */
  executionRunner: "execution_runner",
  /** Server asks: the runner and the turns it runs (DeviceRunnerDetail). */
  readExecutionRunner: "read_execution_runner",
  executionRunnerRead: "execution_runner_read",
  /** Server asks for its owner: stop the listed turns and switch the runner now. */
  switchExecutionRunner: "switch_execution_runner",
  executionRunnerSwitched: "execution_runner_switched",
  installTool: "install_tool",
  toolInstalled: "tool_installed",
  /** Server asks: one action on a device-held connector (connectors.ts). */
  connectorRequest: "connector_request",
  connectorReply: "connector_reply",
  connectorProgress: "connector_progress",
  readRepositoryRefs: "read_repository_refs",
  repositoryRefsRead: "repository_refs_read",
  fetchSkillRepository: "fetch_skill_repository",
  skillRepositoryFetched: "skill_repository_fetched",
  runDiagnostics: "run_diagnostics",
  diagnosticsReady: "diagnostics_ready",
  runRepair: "run_repair",
  repairDone: "repair_done",
  workspaceForgotten: "workspace_forgotten",
  /**
   * Worker news, unasked: which of its workspaces it serves and which it
   * still has but whose folder is gone (WorkspaceFoldersPayload).
   */
  workspaceFolders: "workspace_folders",
  workspaceReady: "workspace_ready",
  workspaceTreeListed: "workspace_tree_listed",
} as const;

export type DaemonMessageType =
  (typeof daemonMessageTypes)[keyof typeof daemonMessageTypes];

const knownDaemonMessageTypes: ReadonlySet<string> = new Set(
  Object.values(daemonMessageTypes),
);

export function isDaemonMessageType(value: string): value is DaemonMessageType {
  return knownDaemonMessageTypes.has(value);
}

/**
 * The workspace_folders capability: hello carries missingWorkspaceIds beside
 * servedWorkspaceIds, the worker sends workspace_folders whenever either
 * changes, and it answers relink_workspace and find_moved_workspace.
 */
export const workspaceFoldersCapability = "workspace_folders";

/** workspace_folders, and the same two lists in hello. */
export interface WorkspaceFoldersPayload {
  /** Workspaces the worker serves, their folders present. */
  servedWorkspaceIds: string[];
  /** Workspaces the worker still has whose folder no longer exists. */
  missingWorkspaceIds: string[];
}

/**
 * registration_needed: the sections, by name, the server does not have. The
 * server keeps the sections of a device's registrations it was sent, by
 * digest, while it runs: a registration may leave out a section the server
 * has (omittedSections) and name each section's digest (sections).
 */
export interface RegistrationNeededPayload {
  sections: string[];
}

/** session_turn: whether the session's agent runs a turn of its own. */
export interface SessionTurnPayload {
  sessionId: string;
  running: boolean;
}

/** A chat's native session, as relink_workspace names it. */
export interface NativeSessionRef {
  provider: "claude" | "codex";
  id: string;
}

/** relink_workspace: serve workspaceId from path, keeping its identity. */
export interface RelinkWorkspacePayload {
  workspaceId: string;
  /** The existing folder to serve it from (absolute, on the device). */
  path: string;
  /** The folder it had (its last known path); may no longer exist. */
  previousPath: string;
  /** Its chats' native sessions, to make them resumable in path. */
  nativeSessions: NativeSessionRef[];
}

/** find_moved_workspace: look for the moved folder near previousPath. */
export interface FindMovedWorkspacePayload {
  workspaceId: string;
  previousPath: string;
}

/** Raw file downloads use bounded chunks, distinct from truncated text previews. */
export interface FileDownloadRequest {
  offset: number;
  /** The first chunk's identity: refuse a changed file on subsequent reads. */
  revision?: string;
}
export interface FileDownloadChunk {
  offset: number;
  size: number;
  revision: string;
  dataBase64: string;
}

/** read_file */
export interface ReadFilePayload {
  download?: FileDownloadRequest;
  path: string;
  workspaceId: string;
}

/**
 * read_device_file: a file of the device outside its workspaces, asked by
 * the server only for the device's owner. `stat` answers what it is; `read`
 * adds the start of a text file unless it looks like a secret; `reveal`
 * adds it even then. A download is refused for a secret.
 */
export interface ReadDeviceFilePayload {
  /** Absolute, or `~/…` for the home folder of the worker's account. */
  path: string;
  mode: "stat" | "read" | "reveal";
  download?: FileDownloadRequest;
}

/** device_file_read */
export interface DeviceFileRead {
  path: string;
  /**
   * `denied`: a credential store or other place Foundry never opens;
   * `not_file`: a folder, device or pipe.
   */
  kind: "file" | "missing" | "denied" | "not_file";
  realPath?: string;
  bytes?: number;
  mtimeMs?: number;
  /** Named or shaped like a secret: shown masked until revealed. */
  sensitive?: boolean;
  /** Not text: only a download shows it. */
  binary?: boolean;
  /** The start of the file, for `read` (not for a secret) and `reveal`. */
  content?: string;
  truncated?: boolean;
  downloadChunk?: FileDownloadChunk;
  /** Why a download chunk was refused (`sensitive`, `too_large`, …). */
  code?: string;
  error?: string;
}

/** read_subagent_transcript */
export interface ReadSubagentTranscriptPayload {
  sessionId: string;
  taskId: string;
  workspaceId: string;
}

/** read_native_history */
export interface ReadNativeHistoryPayload {
  workspaceId: string;
  provider: "claude" | "codex";
  nativeSessionId: string;
  /** Byte offset in the native log: the page ends where this starts. */
  before: number;
}

/** native_history_read: the page, and where it starts (0 at the log's start). */
export interface NativeHistoryReadPayload {
  transcript: TranscriptMessage[];
  before: number;
  error?: string;
}

/** read_session_file */
export interface ReadSessionFilePayload {
  download?: FileDownloadRequest;
  workspaceId: string;
  sessionId: string;
  path: string;
}

/** read_session_file_diff */
export interface ReadSessionFileDiffPayload {
  workspaceId: string;
  sessionId: string;
  path: string;
  inputId?: string;
}

/**
 * read_background_task_output and stop_background_task. The request names a
 * task, never a path. A read that follows a running task's log continues
 * from `after`; stop reads only sessionId and taskId.
 */
export interface BackgroundTaskRequestPayload {
  workspaceId: string;
  sessionId: string;
  taskId: string;
  after?: number;
  follow?: boolean;
}

/** list_subagents */
export interface ListSubagentsPayload {
  sessionId: string;
  workspaceId: string;
  /**
   * "digest": the list as a chat shows it (AgentSubagentDigest), which the
   * reply names; else the whole list, prompts and answers.
   */
  view?: string;
}

/** The view of a subagent list a chat reads (see ListSubagentsPayload). */
export const subagentDigestView = "digest";

/** list_directories */
export interface ListDirectoriesPayload {
  path: string;
}

/** list_workspace_tree */
export interface ListWorkspaceTreePayload {
  path?: string;
  workspaceId: string;
}

/** attachment_write: one chunk of an upload, or its abort. */
export interface AttachmentWritePayload {
  workspaceId: string;
  relativePath: string;
  offset: number;
  dataBase64?: string;
  final?: boolean;
  abort?: boolean;
}

/** attachment_read: one chunk of an attachment image or workspace file. */
export interface AttachmentReadPayload {
  workspaceId: string;
  path: string;
  offset: number;
  maxBytes: number;
  /** "workspace": any file of the workspace, not only an image attachment. */
  scope?: "workspace";
  /** Image derivative; omitted reads original bytes. */
  variant?: "preview" | "placeholder";
  /** Smaller blocks keep original-image progress responsive. */
  chunkBytes?: number;
}

/** setup_workspace */
export interface SetupWorkspacePayload {
  path: string;
  /**
   * Make the folder first (Personal Agent, docs/personal-agent.md §4): only
   * to a worker that declared workspaceCreateCapability. The worker refuses
   * a path that, resolved, is outside its managed roots or already exists.
   */
  create?: SetupWorkspaceCreate;
}

/** setup_workspace's create: an empty folder or a clone. */
export interface SetupWorkspaceCreate {
  kind: "empty" | "clone";
  /** The repository to clone; required for "clone". */
  url?: string;
  /** Run `git init` in the new empty folder; a clone is already one. */
  gitInit: boolean;
  /**
   * Files to write into the new empty folder (the Personal Agent's
   * AGENTS.md): never for a clone, never over an existing file.
   */
  files?: SetupWorkspaceFile[];
}

/** One file setup_workspace's create writes into the new folder. */
export interface SetupWorkspaceFile {
  /** Relative to the folder, "/"-separated; never absolute, never "..". */
  path: string;
  /** UTF-8 text. */
  content: string;
}

/**
 * The worker takes setup_workspace's create and reports its managed roots
 * (DeviceProjection.managedRoots).
 */
export const workspaceCreateCapability = "workspace_create";

/** forget_workspace */
export interface ForgetWorkspacePayload {
  path: string;
  workspaceId: string;
}

/** The profile upsert_agent_profile and list_agent_models carry. */
export interface DaemonAgentProfileInput {
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
  contextWindows?: Record<string, number>;
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
}

/** upsert_agent_profile */
export interface UpsertAgentProfilePayload {
  profile: DaemonAgentProfileInput;
}

/** list_agent_models */
export interface ListAgentModelsPayload {
  profile: DaemonAgentProfileInput;
}

/** upsert_agent_runtime_settings */
export interface UpsertAgentRuntimeSettingsPayload {
  settings: AgentRuntimeSettings;
}

/**
 * read_provider_key: the key one API provider's own configuration names
 * (its `keySource`), for promoting it to a server profile. The server names
 * the provider, never a variable; a provider that names no key yields none.
 */
export interface ReadProviderKeyPayload {
  profileId?: string;
}

/**
 * check_external_connection / remove_external_connection, sent only to a
 * worker that declared external_connection_manage_v1.
 */
export interface ExternalConnectionRequestPayload {
  profileId: string;
}

/** run_session */
export interface RunSessionPayload {
  session: AgentSession;
  /** Server-held credential for the session's profile; memory-only. */
  credential?: string;
  /** One-time bearer token for the spawned agent's MCP/CLI surface. */
  sessionToken?: string;
  /**
   * Server-owned profile definition for this run. When present it is
   * authoritative and the local profiles file is not consulted, so a profile
   * that exists only in the control plane keeps its endpoint and knobs.
   */
  profile?: ProfileDefinition;
  /** The Issue an issue_execution session implements, with its contract. */
  issue?: Issue;
  /** Server decision: readable only for Issues the device owner started. */
  userFiles?: "readable" | "hidden";
  /** The draft and conversation an issue_clarification input is about. */
  clarification?: ClarificationTurn;
  /** Third-party accounts the session may act as: minted tokens, no refresh. */
  externalAccounts?: ExternalAccountMaterial[];
  /** Device-held connectors on the session's device and what it may do with each. */
  deviceConnectors?: DeviceConnectorUse[];
  /**
   * A personal_agent session's appended system prompt (docs/personal-agent.md
   * §12): the prompt, the person's requests and the snapshot of what the
   * assistant knows, in that order. Claude takes it as systemPrompt.append,
   * Codex as developer_instructions.
   */
  personalAgentInstructions?: string;
}

/** steer_session */
export interface SteerSessionPayload {
  /** Authenticated sending session; absent for direct user input. */
  sentBySessionId?: string;
  message?: string;
  attachments?: ChatAttachment[];
  sessionId?: string;
  /**
   * The message's id (a queued message's): a steer the server sends again
   * is applied once.
   */
  inputId?: string;
  /**
   * When a message from another session enters the turn: "interrupt" at
   * once, "boundary" at the turn's next completed step (DEV-057). Absent
   * is the runtime's own way, a person's message.
   */
  delivery?: SteerDelivery;
  /** The longest a boundary message waits before it steers in anyway. */
  boundaryLimitMs?: number;
}

export type SteerDelivery = "interrupt" | "boundary";

/** cancel_session */
export interface CancelSessionPayload {
  sessionId?: string;
  inputId?: string;
}

/** recover_session: answered with session_completed. */
export interface RecoverSessionPayload {
  sessionId?: string;
  inputId?: string;
  workspaceId: string;
  issueId?: string;
  role?: AgentSession["role"];
}

/** read_repository_refs */
export interface ReadRepositoryRefsPayload {
  remote: string;
  /** Every tag (git). */
  tags?: boolean;
  /** HEAD, refs/heads/<name>, refs/tags/<name> and its peeled ref (git). */
  patterns?: string[];
  /** npm registry (https); absent uses this device's npm settings. */
  registry?: string;
}

/** fetch_skill_repository */
export interface FetchSkillRepositoryPayload {
  remote: string;
  ref?: string;
  subpath?: string;
  registry?: string;
  uploadPath: string;
}

/** Disposable prewarm; it never grants a session access to these files. */
export interface PrepareSkillsPayload {
  refs: SessionSkillRef[];
}

/** scan_skills */
export interface ScanSkillsPayload {
  roots?: string[];
  /** Programs library skills need; the reply says which the device has. */
  tools?: unknown;
  /**
   * The digest of the device's last scan answer the server keeps. An answer
   * with that digest goes as only "unchanged" and the digest; every answer
   * carries its digest. Absent when the server keeps none.
   */
  knownDigest?: string;
}

/** read_skill_content */
export interface ReadSkillContentPayload {
  root?: string;
  dirName?: string;
}

/** run_repair */
export interface RunRepairPayload {
  action?: DeviceRepairAction;
}

/** One requested outbound data stream; only an explicit loopback port. */
export interface ServiceTunnelOpenPayload {
  streamId: string;
  workspaceId: string;
  port: number;
  protocol: string;
}

/** Workers that report local TCP listeners for Workspace Services. */
export const serviceListenersCapability = "service_listeners_v1";
/** list_service_listeners: loopback-reachable TCP listeners on the device. */
export interface ListServiceListenersPayload {
  workspaceId: string;
}
/** A listening port. process is an executable/script basename, never argv
 * (command lines can carry secrets), and only for inWorkspace listeners:
 * those whose cwd is in the workspace. */
export interface ServiceListener {
  port: number;
  process?: string;
  inWorkspace: boolean;
  /** A DevTools or Node inspector endpoint: never offered for publishing. */
  debugger?: boolean;
  /** It completed a TLS handshake (checked for workspace listeners only). */
  tls?: boolean;
}
export interface ServiceListenersListedPayload {
  workspaceId: string;
  listeners: ServiceListener[];
  error?: string;
}

/** Workers with reversible native archive and archived chat scanning. */
export const nativeArchiveCapability = "native_archive_v1";
export interface NativeArchivePayload {
  items: NativeArchiveItem[];
  dryRun?: boolean;
}
export interface NativeArchiveResultPayload {
  error?: string;
  items: NativeArchiveResult[];
}
