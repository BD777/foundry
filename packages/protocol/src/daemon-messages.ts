// Canonical daemon WebSocket message vocabulary. Every envelope `type` that
// crosses the server <-> daemon socket is named here exactly once, so the
// TypeScript worker never spells a wire literal by hand.
//
// The Go side keeps its own `ws*Type` constants in
// apps/server/internal/httpapi/daemon_ws.go. `scripts/audit-contract.mjs`
// mechanically compares the two sets; it checks the vocabulary, not payload
// shapes or direction.

export const daemonMessageTypes = {
  ack: "ack",
  agentModelsListed: "agent_models_listed",
  agentProfileUpserted: "agent_profile_upserted",
  attachmentChunkRead: "attachment_chunk_read",
  attachmentRead: "attachment_read",
  attachmentWrite: "attachment_write",
  attachmentWritten: "attachment_written",
  agentRuntimeSettingsUpserted: "agent_runtime_settings_upserted",
  cancelSession: "cancel_session",
  directoriesListed: "directories_listed",
  inspectWorkspace: "inspect_workspace",
  inspectNativeAccount: "inspect_native_account",
  nativeAccountInspected: "native_account_inspected",
  installNativeCli: "install_native_cli",
  nativeCliInstalled: "native_cli_installed",
  workspaceInspected: "workspace_inspected",
  error: "error",
  fileRead: "file_read",
  forgetWorkspace: "forget_workspace",
  heartbeat: "heartbeat",
  hello: "hello",
  issueEnvironment: "issue_environment",
  issueEnvironmentResult: "issue_environment_result",
  evidenceRequest: "evidence_request",
  evidenceResult: "evidence_result",
  listAgentModels: "list_agent_models",
  listDirectories: "list_directories",
  listSubagents: "list_subagents",
  listWorkspaceTree: "list_workspace_tree",
  profileCredentialRead: "profile_credential_read",
  readFile: "read_file",
  readProfileCredential: "read_profile_credential",
  readSkillFile: "read_skill_file",
  skillFileRead: "skill_file_read",
  readSkillContent: "read_skill_content",
  readSubagentTranscript: "read_subagent_transcript",
  readSessionUsage: "read_session_usage",
  readSessionFile: "read_session_file",
  sessionFileRead: "session_file_read",
  readSessionFileDiff: "read_session_file_diff",
  sessionFileDiffRead: "session_file_diff_read",
  readBackgroundTaskOutput: "read_background_task_output",
  backgroundTaskOutputRead: "background_task_output_read",
  stopBackgroundTask: "stop_background_task",
  backgroundTaskStopped: "background_task_stopped",
  readyForIssue: "ready_for_issue",
  refreshResources: "refresh_resources",
  resourcesRefreshed: "resources_refreshed",
  recoverSession: "recover_session",
  registered: "registered",
  runSession: "run_session",
  scanSkills: "scan_skills",
  sessionCanceled: "session_canceled",
  sessionBlocked: "session_blocked",
  sessionResumed: "session_resumed",
  sessionCompleted: "session_completed",
  sessionEvent: "session_event",
  sessionNativeSessionId: "session_native_session_id",
  sessionStarted: "session_started",
  sessionSteered: "session_steered",
  sessionUsageRead: "session_usage_read",
  skillContentRead: "skill_content_read",
  setupWorkspace: "setup_workspace",
  steerSession: "steer_session",
  subagentTranscriptRead: "subagent_transcript_read",
  subagentsListed: "subagents_listed",
  skillsScanned: "skills_scanned",
  upsertAgentProfile: "upsert_agent_profile",
  upsertAgentRuntimeSettings: "upsert_agent_runtime_settings",
  updateWorker: "update_worker",
  workerUpdateStarted: "worker_update_started",
  readWorkerUpdateStatus: "read_worker_update_status",
  workerUpdateStatus: "worker_update_status",
  installTool: "install_tool",
  toolInstalled: "tool_installed",
  readRepositoryRefs: "read_repository_refs",
  repositoryRefsRead: "repository_refs_read",
  fetchSkillRepository: "fetch_skill_repository",
  skillRepositoryFetched: "skill_repository_fetched",
  runDiagnostics: "run_diagnostics",
  diagnosticsReady: "diagnostics_ready",
  runRepair: "run_repair",
  repairDone: "repair_done",
  workspaceForgotten: "workspace_forgotten",
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
