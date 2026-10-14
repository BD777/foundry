package httpapi

import (
	"encoding/json"
	"errors"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	wsAckType                      = "ack"
	wsErrorType                    = "error"
	wsHelloType                    = "hello"
	wsHeartbeatType                = "heartbeat"
	wsReadFileType                 = "read_file"
	wsFileReadType                 = "file_read"
	wsReadSubagentTranscriptType   = "read_subagent_transcript"
	wsSubagentTranscriptReadType   = "subagent_transcript_read"
	wsReadSessionUsageType         = "read_session_usage"
	wsSessionUsageReadType         = "session_usage_read"
	wsReadSessionFileType          = "read_session_file"
	wsSessionFileReadType          = "session_file_read"
	wsReadSessionFileDiffType      = "read_session_file_diff"
	wsSessionFileDiffReadType      = "session_file_diff_read"
	wsReadBackgroundTaskOutputType = "read_background_task_output"
	wsBackgroundTaskOutputReadType = "background_task_output_read"
	wsStopBackgroundTaskType       = "stop_background_task"
	wsBackgroundTaskStoppedType    = "background_task_stopped"
	wsListSubagentsType            = "list_subagents"
	wsSubagentsListedType          = "subagents_listed"
	wsListDirectoriesType          = "list_directories"
	wsDirectoriesListedType        = "directories_listed"
	wsListWorkspaceTreeType        = "list_workspace_tree"
	wsWorkspaceTreeListedType      = "workspace_tree_listed"
	wsInspectWorkspaceType         = "inspect_workspace"
	wsInspectNativeAccountType     = "inspect_native_account"
	wsNativeAccountInspectedType   = "native_account_inspected"
	wsInstallNativeCliType         = "install_native_cli"
	wsNativeCliInstalledType       = "native_cli_installed"
	wsUpdateWorkerType             = "update_worker"
	wsWorkerUpdateStartedType      = "worker_update_started"
	wsReadWorkerUpdateStatusType   = "read_worker_update_status"
	wsWorkerUpdateStatusType       = "worker_update_status"
	wsInstallToolType              = "install_tool"
	wsRunDiagnosticsType           = "run_diagnostics"
	wsDiagnosticsReadyType         = "diagnostics_ready"
	wsRunRepairType                = "run_repair"
	wsRepairDoneType               = "repair_done"
	wsToolInstalledType            = "tool_installed"
	wsConnectorRequestType         = "connector_request"
	wsConnectorReplyType           = "connector_reply"
	wsReadRepositoryRefsType       = "read_repository_refs"
	wsRepositoryRefsReadType       = "repository_refs_read"
	wsFetchSkillRepositoryType     = "fetch_skill_repository"
	wsSkillRepositoryFetchedType   = "skill_repository_fetched"
	wsWorkspaceInspectedType       = "workspace_inspected"
	wsSetupWorkspaceType           = "setup_workspace"
	wsWorkspaceReadyType           = "workspace_ready"
	wsForgetWorkspaceType          = "forget_workspace"
	wsWorkspaceForgottenType       = "workspace_forgotten"
	wsRelinkWorkspaceType          = "relink_workspace"
	wsWorkspaceRelinkedType        = "workspace_relinked"
	wsFindMovedWorkspaceType       = "find_moved_workspace"
	wsMovedWorkspaceFoundType      = "moved_workspace_found"
	wsUpsertAgentProfileType       = "upsert_agent_profile"
	wsAgentProfileUpsertedType     = "agent_profile_upserted"
	wsUpsertRuntimeSettingsType    = "upsert_agent_runtime_settings"
	wsRuntimeSettingsUpsertedType  = "agent_runtime_settings_upserted"
	wsRefreshResourcesType         = "refresh_resources"
	wsResourcesRefreshedType       = "resources_refreshed"
	wsListAgentModelsType          = "list_agent_models"
	wsAttachmentWriteType          = "attachment_write"
	wsAttachmentWrittenType        = "attachment_written"
	wsAttachmentReadType           = "attachment_read"
	wsAttachmentChunkReadType      = "attachment_chunk_read"
	wsAgentModelsListedType        = "agent_models_listed"
	wsReadProviderKeyType          = "read_provider_key"
	wsProviderKeyReadType          = "provider_key_read"
	wsScanSkillsType               = "scan_skills"
	wsSkillsScannedType            = "skills_scanned"
	wsReadSkillContentType         = "read_skill_content"
	wsReadSkillFileType            = "read_skill_file"
	wsSkillFileReadType            = "skill_file_read"
	wsSkillContentReadType         = "skill_content_read"
	wsRegisteredType               = "registered"
	wsRegistrationNeededType       = "registration_needed"
	wsIssueEnvironmentType         = "issue_environment"
	wsIssueEnvironmentResultType   = "issue_environment_result"
	wsEvidenceRequestType          = "evidence_request"
	wsEvidenceResultType           = "evidence_result"
	wsReadyForIssueType            = "ready_for_issue"
	wsRunSessionType               = "run_session"
	wsSteerSessionType             = "steer_session"
	wsSessionSteeredType           = "session_steered"
	wsCancelSessionType            = "cancel_session"
	wsSessionCanceledType          = "session_canceled"
	wsSessionStartedType           = "session_started"
	wsSessionEventType             = "session_event"
	wsSessionBlockedType           = "session_blocked"
	wsSessionResumedType           = "session_resumed"
	wsSessionNativeSessionIDType   = "session_native_session_id"
	wsSessionCompleteType          = "session_completed"
	wsRecoverSessionType           = "recover_session"
	// A session's timers the server knows, sent to its device on hello
	// (session_timers.go); older workers ignore it.
	wsSessionTimersType = "session_timers"
	// A model turn a session's agent started or ended on its own (a
	// timer's, or its follow-up after background work); sent only to a
	// server whose registered answer lists sessionTurnsFeature.
	wsSessionTurnType = "session_turn"
	// A piece of a large envelope; see daemon_reply_chunks.go.
	wsReplyChunkType = "reply_chunk"
)

// Changes a device tells on its own; nothing answers them.
const (
	// Which of its workspaces a worker serves and which it has lost the
	// folder of (workspace_availability.go).
	wsWorkspaceFoldersType            = "workspace_folders"
	wsBackgroundTaskOutputChangedType = "background_task_output_changed"
	wsIssueEnvironmentChangedType     = "issue_environment_changed"
	// A worker's whole resource inventory (resources.go).
	wsResourcesReportType = "resources_report"
	// Operating a leased resource on its hosting worker, fencing and
	// resetting it, installing a backend (resource_leases.go).
	wsResourceOperateType          = "resource_operate"
	wsResourceOperatedType         = "resource_operated"
	wsResourceResetType            = "resource_reset"
	wsResourceResetDoneType        = "resource_reset_done"
	wsInstallResourceBackendType   = "install_resource_backend"
	wsResourceBackendInstalledType = "resource_backend_installed"
	// The device owner's resource settings, which the worker enforces too.
	wsResourceSettingsType        = "resource_settings"
	wsResourceSettingsAppliedType = "resource_settings_applied"
)

type wsEnvelope struct {
	Error   string          `json:"error,omitempty"`
	ID      string          `json:"id,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
	Type    string          `json:"type"`
}

type wsReadFilePayload struct {
	WorkspaceID string `json:"workspaceId"`
	Path        string `json:"path"`
}

type wsFileReadPayload struct {
	WorkspaceID string `json:"workspaceId"`
	Path        string `json:"path"`
	Content     string `json:"content"`
	Truncated   bool   `json:"truncated"`
	wsReplyError
}

type wsReadSubagentTranscriptPayload struct {
	WorkspaceID string `json:"workspaceId"`
	SessionID   string `json:"sessionId"`
	TaskID      string `json:"taskId"`
}

type wsSubagentTranscriptReadPayload struct {
	store.AgentSubagentTranscript
	wsReplyError
}

type wsReadSessionFilePayload struct {
	WorkspaceID string `json:"workspaceId"`
	SessionID   string `json:"sessionId"`
	Path        string `json:"path"`
}

type wsSessionFileReadPayload struct {
	store.SessionFileRead
	wsReplyError
}

type wsReadSessionFileDiffPayload struct {
	WorkspaceID string `json:"workspaceId"`
	SessionID   string `json:"sessionId"`
	Path        string `json:"path"`
	InputID     string `json:"inputId,omitempty"`
}

type wsSessionFileDiffReadPayload struct {
	store.SessionFileDiff
	wsReplyError
}

type wsListSubagentsPayload struct {
	WorkspaceID string `json:"workspaceId"`
	SessionID   string `json:"sessionId"`
	// View is subagentDigestView for the list as a chat shows it; workers
	// before 0.5.7 answer every read with the whole list.
	View string `json:"view,omitempty"`
}

// subagentDigestView asks a device for its subagent list as digests
// (store.AgentSubagentDigest), and its answer says it gave them.
const subagentDigestView = "digest"

type wsSubagentsListedPayload struct {
	SessionID string `json:"sessionId"`
	// View is the view Subagents are in: subagentDigestView, or "" for
	// store.AgentSubagentSummary.
	View      string          `json:"view,omitempty"`
	Subagents json.RawMessage `json:"subagents"`
	wsReplyError
}

type wsListDirectoriesPayload struct {
	Path string `json:"path"`
}

type wsDirectoriesListedPayload struct {
	Path        string                          `json:"path"`
	Directories []store.WorkspaceDirectoryEntry `json:"directories"`
	wsReplyError
}

type wsListWorkspaceTreePayload struct {
	WorkspaceID string `json:"workspaceId"`
	Path        string `json:"path"`
}

type wsWorkspaceTreeListedPayload struct {
	WorkspaceID string                     `json:"workspaceId"`
	Path        string                     `json:"path"`
	Entries     []store.WorkspaceTreeEntry `json:"entries"`
	wsReplyError
}

type wsSetupWorkspacePayload struct {
	Path string `json:"path"`
}

type wsWorkspaceReadyPayload struct {
	Registration store.DaemonRegistration `json:"registration"`
	wsReplyError
}

type wsForgetWorkspacePayload struct {
	WorkspaceID string `json:"workspaceId"`
	Path        string `json:"path"`
}

type wsWorkspaceForgottenPayload struct {
	WorkspaceID string `json:"workspaceId"`
	wsReplyError
}

type wsUpsertAgentProfilePayload struct {
	Profile store.CreateAgentProfileInput `json:"profile"`
}

type wsAgentProfileUpsertedPayload struct {
	Registration store.DaemonRegistration     `json:"registration"`
	Profile      store.AgentProfileProjection `json:"profile"`
	wsReplyError
}

type wsUpsertAgentRuntimeSettingsPayload struct {
	Settings store.AgentRuntimeSettings `json:"settings"`
}

type wsAgentRuntimeSettingsUpsertedPayload struct {
	Registration store.DaemonRegistration   `json:"registration"`
	Settings     store.AgentRuntimeSettings `json:"settings"`
	wsReplyError
}

// wsRefreshResourcesPayload asks a device to detect its resources again,
// first asking the person there for access to one (RequestAccess) if set.
type wsRefreshResourcesPayload struct {
	RequestAccess string `json:"requestAccess,omitempty"`
}

type wsResourcesRefreshedPayload struct {
	Registration store.DaemonRegistration `json:"registration"`
	Resources    []store.DeviceResource   `json:"resources"`
	// Opened names the settings panes the device opened for the person.
	Opened []string `json:"opened,omitempty"`
	wsReplyError
}

type wsListAgentModelsPayload struct {
	Profile store.CreateAgentProfileInput `json:"profile"`
}

type wsAgentModelsListedPayload struct {
	Models []store.AgentModelOption `json:"models"`
	wsReplyError
}

// wsReadProviderKeyPayload asks the daemon for the key one provider's own
// configuration names, so promotion can seal it server-side. It names the
// provider, never a variable. The value comes back in wsProviderKeyReadPayload
// and is never logged.
type wsReadProviderKeyPayload struct {
	ProfileID string `json:"profileId"`
}

type wsProviderKeyReadPayload struct {
	// KeySource names where the key was read, e.g. "$LLM_GATEWAY_KEY"; empty
	// when the provider's configuration names none.
	KeySource  string `json:"keySource,omitempty"`
	Credential string `json:"credential,omitempty"`
	wsReplyError
}

type wsRunSessionPayload struct {
	Session store.AgentSession `json:"session"`
	// Profile is the authoritative server-owned definition for sessions that
	// run a server profile. Without it the daemon falls back to its local
	// profiles file, which would silently drop baseUrl and send the credential
	// to the vendor's public endpoint.
	Profile    *store.ProfileDefinition `json:"profile,omitempty"`
	Credential string                   `json:"credential,omitempty"`
	// SessionToken is the one-time bearer token the spawned agent presents to
	// the MCP/CLI surface. Minted per dispatch (so reconnects rotate it);
	// never persisted in plaintext.
	SessionToken string `json:"sessionToken,omitempty"`
	// Issue is the Issue an issue_execution session implements, with its
	// confirmed contract attached.
	Issue *store.Issue `json:"issue,omitempty"`
	// UserFiles lets the Issue's processes read the device owner's own files
	// and credentials. Only an Issue the device owner started may; anyone
	// else's Issue must not act with the owner's credentials.
	UserFiles string `json:"userFiles,omitempty"`
	// Clarification is the draft and conversation an issue_clarification
	// input is about.
	Clarification *store.ClarificationTurn `json:"clarification,omitempty"`
	// ExternalAccounts are the third-party accounts the session may act as,
	// each with a short-lived access token (never a refresh token); only an
	// account owner's own session on their own device gets them.
	ExternalAccounts []store.ExternalAccountMaterial `json:"externalAccounts,omitempty"`
	// DeviceConnectors are the device-held connectors on the session's
	// device and what the session may do with each (connectors.DeviceHeld).
	DeviceConnectors []store.DeviceConnectorUse `json:"deviceConnectors,omitempty"`
}

type wsSteerSessionPayload struct {
	Message     string                 `json:"message"`
	Attachments []store.ChatAttachment `json:"attachments,omitempty"`
	SessionID   string                 `json:"sessionId"`
	// InputID is the message's id (a queued message's): a worker that
	// already applied a steer with it answers without applying it again,
	// and names its transcript event evt_<InputID>. Older workers ignore it.
	InputID string `json:"inputId,omitempty"`
}

type wsSessionSteeredPayload struct {
	wsReplyError
	SessionID string `json:"sessionId"`
	// InputID echoes the steer's id; older workers send none.
	InputID string `json:"inputId,omitempty"`
}

type wsCancelSessionPayload struct {
	SessionID string `json:"sessionId"`
	// InputID names the input to stop, so a cancel that reaches the worker
	// before the input starts cannot stop a later input of the session.
	InputID string `json:"inputId,omitempty"`
}

type wsSessionCanceledPayload struct {
	wsReplyError
	SessionID string `json:"sessionId"`
	// Answered: the turn had already answered, and the stop ended only the
	// background work it waited for. The device reports the session
	// completed with that answer instead of canceled.
	Answered bool `json:"answered,omitempty"`
}

type wsSessionStartedPayload struct {
	SessionID string `json:"sessionId"`
	// InputID names the input this lifecycle message belongs to; a message
	// about an earlier input of the session is stale and ignored.
	InputID string `json:"inputId,omitempty"`
}

// wsSessionTurnPayload: the session's agent runs a turn of its own
// (running) or no longer does.
type wsSessionTurnPayload struct {
	SessionID string `json:"sessionId"`
	Running   bool   `json:"running"`
}

type wsSessionEventPayload struct {
	Event store.AgentSessionEvent `json:"event"`
}

type wsSessionNativeSessionIDPayload struct {
	SessionID       string `json:"sessionId"`
	NativeSessionID string `json:"nativeSessionId"`
}

type wsSessionCompletedPayload struct {
	SessionID       string `json:"sessionId"`
	InputID         string `json:"inputId,omitempty"`
	NativeSessionID string `json:"nativeSessionId,omitempty"`
	Response        string `json:"response,omitempty"`
	Error           string `json:"error,omitempty"`
	// IssueResult is what an issue_execution session produced: the candidate
	// it left and the acceptance artifact.
	IssueResult *store.CompleteIssueInput `json:"issueResult,omitempty"`
	// ClarificationResult is an issue_clarification session's reply.
	ClarificationResult *store.ClarificationResponse `json:"clarificationResult,omitempty"`
}

// wsRecoverSessionPayload asks a device about an input it no longer runs. The
// device answers with session_completed: the result it recorded, or that the
// result was lost.
type wsRecoverSessionPayload struct {
	SessionID   string `json:"sessionId"`
	InputID     string `json:"inputId,omitempty"`
	WorkspaceID string `json:"workspaceId"`
	IssueID     string `json:"issueId,omitempty"`
	// Role tells the device where the session kept its result.
	Role string `json:"role,omitempty"`
}

// wsReplyError is the refusal a device's answer to a request may carry.
type wsReplyError struct {
	Error string `json:"error,omitempty"`
}

func (r wsReplyError) refusal() error { return replyRefusal(r.Error) }

// replyRefusal is the error an answer's error field reports, nil for none.
func replyRefusal(message string) error {
	if message == "" {
		return nil
	}
	return errors.New(message)
}

// A session file answer's error is the device refusing the path.
func (p wsSessionFileReadPayload) refusal() error     { return sessionFileRefused(p.Error) }
func (p wsSessionFileDiffReadPayload) refusal() error { return sessionFileRefused(p.Error) }

// sessionFileRefusal is a device's answer that the path is not one of the
// session's readable files (not recorded, moved, or private).
type sessionFileRefusal struct{ reason string }

func (r sessionFileRefusal) Error() string { return r.reason }

func sessionFileRefused(reason string) error {
	if reason == "" {
		return nil
	}
	return sessionFileRefusal{reason}
}
