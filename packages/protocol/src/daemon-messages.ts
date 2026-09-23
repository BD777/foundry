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
  agentRuntimeSettingsUpserted: "agent_runtime_settings_upserted",
  cancelSession: "cancel_session",
  completeProfileAuthorization: "complete_profile_authorization",
  directoriesListed: "directories_listed",
  inspectWorkspace: "inspect_workspace",
  inspectNativeAccount: "inspect_native_account",
  nativeAccountInspected: "native_account_inspected",
  workspaceInspected: "workspace_inspected",
  error: "error",
  fileRead: "file_read",
  forgetWorkspace: "forget_workspace",
  heartbeat: "heartbeat",
  hello: "hello",
  issueCompleted: "issue_completed",
  issueEnvironment: "issue_environment",
  issueEnvironmentResult: "issue_environment_result",
  evidenceRequest: "evidence_request",
  evidenceResult: "evidence_result",
  listAgentModels: "list_agent_models",
  listDirectories: "list_directories",
  listSubagents: "list_subagents",
  listWorkspaceTree: "list_workspace_tree",
  profileAuthorizationCompleted: "profile_authorization_completed",
  profileAuthorizationStarted: "profile_authorization_started",
  profileCredentialRead: "profile_credential_read",
  readFile: "read_file",
  readProfileCredential: "read_profile_credential",
  readSkillFile: "read_skill_file",
  skillFileRead: "skill_file_read",
  readSkillContent: "read_skill_content",
  readSubagentTranscript: "read_subagent_transcript",
  readyForIssue: "ready_for_issue",
  registered: "registered",
  runEvent: "run_event",
  runIssue: "run_issue",
  runSession: "run_session",
  runStarted: "run_started",
  scanSkills: "scan_skills",
  sessionCanceled: "session_canceled",
  sessionBlocked: "session_blocked",
  sessionResumed: "session_resumed",
  sessionCompleted: "session_completed",
  sessionEvent: "session_event",
  sessionNativeSessionId: "session_native_session_id",
  sessionStarted: "session_started",
  sessionSteered: "session_steered",
  skillContentRead: "skill_content_read",
  startProfileAuthorization: "start_profile_authorization",
  setupWorkspace: "setup_workspace",
  steerSession: "steer_session",
  subagentTranscriptRead: "subagent_transcript_read",
  subagentsListed: "subagents_listed",
  skillsScanned: "skills_scanned",
  upsertAgentProfile: "upsert_agent_profile",
  upsertAgentRuntimeSettings: "upsert_agent_runtime_settings",
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
