package store

// SessionTokenIdentity is the resolved actor behind a valid agent session
// bearer token. AccountID is reserved for the upcoming accounts system.
type SessionTokenIdentity struct {
	SessionID   string `json:"sessionId"`
	WorkspaceID string `json:"workspaceId"`
	DeviceID    string `json:"deviceId"`
	AccountID   string `json:"accountId,omitempty"`
}

type AgentSessionEvent struct {
	ID        string                     `json:"id"`
	SessionID string                     `json:"sessionId"`
	At        string                     `json:"at"`
	Label     string                     `json:"label"`
	Detail    string                     `json:"detail"`
	Level     string                     `json:"level"`
	Metadata  *AgentSessionEventMetadata `json:"metadata,omitempty"`
	Message   *TranscriptMessage         `json:"message,omitempty"`
}

// WorkerFailure is a versioned diagnosis; the server preserves it without guessing causes.
type WorkerFailure struct {
	Version int    `json:"version"`
	Code    string `json:"code"`
	InputID string `json:"inputId,omitempty"`
}

type AgentSessionEventMetadata struct {
	WorkerFailure        *WorkerFailure `json:"workerFailure,omitempty"`
	NativeAccountError   string         `json:"nativeAccountError,omitempty"`
	NativeAccountInputID string         `json:"nativeAccountInputId,omitempty"`
	// TaskOutputFile is a Claude background task's own output log. Workers
	// before it sent that path, and every changed workspace file, as
	// outputFile; that key is no longer read, so those guesses stay hidden.
	TaskOutputFile string             `json:"taskOutputFile,omitempty"`
	SessionFile    *SessionFileRecord `json:"sessionFile,omitempty"`
	// ToolFrame is a screenshot a tool call produced, kept as a session
	// file on the device (DEV-075).
	ToolFrame      *SessionToolFrame      `json:"toolFrame,omitempty"`
	FileReferences []SessionFileReference `json:"fileReferences,omitempty"`
	Prompt         string                 `json:"prompt,omitempty"`
	SubagentType   string                 `json:"subagentType,omitempty"`
	TaskID         string                 `json:"taskId,omitempty"`
	TaskType       string                 `json:"taskType,omitempty"`
	ToolUseID      string                 `json:"toolUseId,omitempty"`
	// Snapshots replace earlier ones, so an empty one is kept: it says the
	// last timer or task is gone.
	TimerSnapshot          *[]AgentScheduledTask  `json:"timerSnapshot,omitempty"`
	BackgroundTaskSnapshot *[]AgentBackgroundTask `json:"backgroundTaskSnapshot,omitempty"`
	TimerFire              *AgentSessionTimerFire `json:"timerFire,omitempty"`
	TurnUsage              *AgentTurnUsage        `json:"turnUsage,omitempty"`
	// SubagentUsage is what a Claude subagent has used so far, on its
	// progress and completion events.
	SubagentUsage *SubagentUsage `json:"subagentUsage,omitempty"`
	// RequestUsage is a model request's final tokens (Claude), reported
	// when its stream ends; the event itself is not shown.
	RequestUsage *ModelRequestUsage `json:"requestUsage,omitempty"`
	// ContextUsage is how full the session's context is after a main-agent
	// model request or a compaction; the newest counts.
	ContextUsage *AgentContextUsage `json:"contextUsage,omitempty"`
	// CodexTransport is what a Codex session showed about its compatible
	// endpoint's Responses WebSocket; the server keeps it for the profile.
	CodexTransport *CodexTransportReport `json:"codexTransport,omitempty"`
	// SentBySessionID, on a message's event (its input, or a message
	// steered into a running turn), is the session that sent it; empty for
	// what the person typed. Viewers resolve its title themselves, as far
	// as they may read that session.
	SentBySessionID string `json:"sentBySessionId,omitempty"`
}

// SessionInputEventLabel marks the transcript event each session input
// writes; the transcript of a session is its events alone.
const SessionInputEventLabel = "User message"

// AgentSessionRoleIssueExecution is the session that implements an Issue.
const AgentSessionRoleIssueExecution = "issue_execution"

// AgentSessionRoleIssueClarification is the Issue's clarification
// conversation: one read-only session in the Issue's workspace whose every
// message from the person is a new input.
const AgentSessionRoleIssueClarification = "issue_clarification"

// SessionInput is one message delivered to a session: the unit of dispatch.
// It is not a session of its own; identity, permissions and lineage belong
// to the session it was sent to.
type SessionExecutionBudget struct {
	SnapshotID     string `json:"snapshotId"`
	TokenBudget    int64  `json:"tokenBudget"`
	TimeoutMinutes int    `json:"timeoutMinutes"`
}

type SessionInput struct {
	ExecutionBudget       *SessionExecutionBudget `json:"executionBudget,omitempty"`
	ID                    string                  `json:"id"`
	Prompt                string                  `json:"prompt"`
	Attachments           []ChatAttachment        `json:"attachments,omitempty"`
	ProfileTransitionNote string                  `json:"profileTransitionNote,omitempty"`
	ImportedContext       string                  `json:"importedContext,omitempty"`
	// When the server received the input; its transcript events carry it.
	At string `json:"at,omitempty"`
	// TimerFire is set when the input is a timer's prompt: its device
	// resumed the session because the timer was due while no agent process
	// ran it. Its transcript event shows the timer firing.
	TimerFire *AgentSessionTimerFire `json:"timerFire,omitempty"`
	// SentBySessionID is the session that sent the input (create_session's
	// first message, send_message); its transcript event names it.
	SentBySessionID string `json:"sentBySessionId,omitempty"`
}

// SessionLink names a session for a link to it: where it is and the title
// its chat shows.
type SessionLink struct {
	ArchivedAt  string `json:"archivedAt,omitempty"`
	ID          string `json:"id"`
	WorkspaceID string `json:"workspaceId"`
	Title       string `json:"title"`
}

// NativeSessionRef names one native Claude Code or Codex session.
type NativeSessionRef struct {
	Provider        string `json:"provider"`
	NativeSessionID string `json:"nativeSessionId"`
}

// AgentSession is one native agent session (a Claude Code or Codex session)
// for its whole life. Conversation turns stay inside the native agent; the
// session carries its latest input and the status of handling it.
type AgentSession struct {
	ChatArchive
	// CreatedByUserID is the account that started it; agent-created sessions
	// inherit their parent's. Set by the server, never by clients.
	CreatedByUserID string `json:"createdByUserId,omitempty"`
	ID              string `json:"id"`
	// ThreadID equals ID; it remains so readers that grouped legacy
	// per-turn rows keep working.
	ThreadID string `json:"threadId,omitempty"`
	// NativeSessionID is the native session it resumes on the runtime it
	// runs on (its provider on its device); empty starts one there. The
	// store owns every native session a session ran (sqlitestore
	// native_sessions.go); this is that record's projection.
	NativeSessionID string `json:"nativeSessionId,omitempty"`
	// ForkNativeSessionID, set while a fork has not answered yet, is the
	// native session NativeSessionID starts as a copy of.
	ForkNativeSessionID string `json:"forkNativeSessionId,omitempty"`
	WorkspaceID         string `json:"workspaceId"`
	AgentID             string `json:"agentId"`
	DeviceID            string `json:"deviceId"`
	Provider            string `json:"provider"`
	ProfileID           string `json:"profileId,omitempty"`
	ProfileFingerprint  string `json:"profileFingerprint,omitempty"`
	ProfileLabel        string `json:"profileLabel,omitempty"`
	Source              string `json:"source,omitempty"`
	// Role is the job the session does for Foundry; empty for a chat.
	// AgentSessionRoleIssueExecution implements an Issue's confirmed contract
	// in its candidate workspace; AgentSessionRoleIssueClarification talks
	// the Issue through with the person, read-only.
	Role string `json:"role,omitempty"`
	// ParentSessionID records orchestration lineage: the agent session that
	// created this one. Empty for human/browser chats. It is a record for
	// display and limits, never a source of permission.
	ParentSessionID string `json:"parentSessionId,omitempty"`
	// IssueID runs the session inside an existing Issue candidate worktree
	// instead of the workspace root, enabling safe parallel writes.
	IssueID string `json:"issueId,omitempty"`
	// GroupNameTarget marks a source=naming utility session whose response
	// should rename the auto-created orchestration group with this id.
	GroupNameTarget string `json:"groupNameTarget,omitempty"`
	// AdoptedChatID names the device's native chat a new session took over
	// (its title, queue and list position), named by its chat id or by its
	// native session id, so the HTTP layer can announce the change. It is
	// set only on the session CreateAgentSession returns.
	AdoptedChatID string `json:"-"`
	// CreatedGroupID is populated on a session that caused a new orchestration
	// group to be created, so the HTTP layer can trigger async naming.
	CreatedGroupID       string `json:"createdGroupId,omitempty"`
	Model                string `json:"model,omitempty"`
	ClaudeEffort         string `json:"claudeEffort,omitempty"`
	ClaudePermissionMode string `json:"claudePermissionMode,omitempty"`
	CodexReasoningEffort string `json:"codexReasoningEffort,omitempty"`
	CodexSandboxMode     string `json:"codexSandboxMode,omitempty"`
	CodexApprovalPolicy  string `json:"codexApprovalPolicy,omitempty"`
	CodexSpeed           string `json:"codexSpeed,omitempty"`
	Status               string `json:"status"`
	BlockedReason        string `json:"blockedReason,omitempty"`
	Title                string `json:"title"`
	// Prompt is the session's opening goal.
	Prompt string `json:"prompt"`
	// Input is the latest message sent to the session; Status describes it.
	Input                SessionInput            `json:"input"`
	SkillRefs            []SessionSkillRef       `json:"skillRefs,omitempty"`
	SkillSelection       *ResolvedSkillSelection `json:"skillSelection,omitempty"`
	WorkspaceDraftSkills bool                    `json:"workspaceDraftSkills,omitempty"`
	// Response is the answer to the latest input.
	Response       string `json:"response,omitempty"`
	Error          string `json:"error,omitempty"`
	StartedAt      string `json:"startedAt,omitempty"`
	LastActivityAt string `json:"lastActivityAt,omitempty"`
	// ActivityAt is its last conversation activity: the latest input, or
	// the answer that completed it. Chat lists order by it.
	ActivityAt     string `json:"activityAt,omitempty"`
	CompletedAt    string `json:"completedAt,omitempty"`
	AnswerRevision string `json:"answerRevision,omitempty"`
	CreatedLabel   string `json:"createdLabel"`
	UpdatedLabel   string `json:"updatedLabel"`
	// Scheduled is set while the agent holds timers that will wake the
	// session; the store keeps it from the session's timer snapshots.
	Scheduled *AgentSessionSchedule `json:"scheduled,omitempty"`
	Events    []AgentSessionEvent   `json:"events,omitempty"`
}

// SendAgentSessionInput is a new message for an idle session. Setting the
// agent, provider or profile switches the runtime the session continues on.
type SendAgentSessionInput struct {
	ExecutionBudget                *SessionExecutionBudget `json:"-"`
	PersonalAgentOperationID       string                  `json:"-"`
	PersonalAgentOperationRevision int64                   `json:"-"`
	AgentID                        string                  `json:"agentId,omitempty"`
	Provider                       string                  `json:"provider,omitempty"`
	ProfileID                      string                  `json:"profileId,omitempty"`
	Model                          string                  `json:"model,omitempty"`
	ClaudeEffort                   string                  `json:"claudeEffort,omitempty"`
	ClaudePermissionMode           string                  `json:"claudePermissionMode,omitempty"`
	CodexReasoningEffort           string                  `json:"codexReasoningEffort,omitempty"`
	CodexSandboxMode               string                  `json:"codexSandboxMode,omitempty"`
	CodexApprovalPolicy            string                  `json:"codexApprovalPolicy,omitempty"`
	CodexSpeed                     string                  `json:"codexSpeed,omitempty"`
	Prompt                         string                  `json:"prompt"`
	Attachments                    []ChatAttachment        `json:"attachments,omitempty"`
	ProfileTransitionNote          string                  `json:"profileTransitionNote,omitempty"`
	// ImportedContext is ignored: the server tells each native session the
	// turns it missed. Accepted so older clients that send it still work.
	ImportedContext string `json:"importedContext,omitempty"`
	// RequireIdle refuses (ErrAgentSessionActive) a message to a running
	// session instead of steering it: the sender meant the next turn.
	RequireIdle bool `json:"requireIdle,omitempty"`
	// Delivery is when a message steered into a running turn enters it
	// (DeliveryInterrupt or DeliveryBoundary, DEV-057); empty is the
	// runtime's own way. Set by the server, never by clients.
	Delivery string `json:"-"`
	// InputID names the input: a queued message's id, or the id a client
	// gave its message so a retried send records it once (see
	// ValidSessionInputID). Empty generates one.
	InputID string `json:"inputId,omitempty"`
	// TimerFire marks the input as a timer's prompt (set by the server for
	// a device that resumes a session for a due timer, never by clients).
	TimerFire *AgentSessionTimerFire `json:"-"`
	// SentBySessionID is the session sending the message (set by the
	// server from the caller's session token, never by clients).
	SentBySessionID string `json:"-"`
}

type CreateAgentSessionInput struct {
	ExecutionBudget                *SessionExecutionBudget `json:"-"`
	PersonalAgentOperationID       string                  `json:"-"`
	PersonalAgentOperationRevision int64                   `json:"-"`
	SkillSelection                 *SkillSelection         `json:"skillSelection,omitempty"`
	ResolvedSkillSelection         *ResolvedSkillSelection `json:"-"`
	CreatedByUserID                string                  `json:"-"`
	WorkspaceID                    string                  `json:"workspaceId"`
	NativeSessionID                string                  `json:"nativeSessionId,omitempty"`
	AgentID                        string                  `json:"agentId"`
	Provider                       string                  `json:"provider"`
	ProfileID                      string                  `json:"profileId,omitempty"`
	Model                          string                  `json:"model,omitempty"`
	ClaudeEffort                   string                  `json:"claudeEffort,omitempty"`
	ClaudePermissionMode           string                  `json:"claudePermissionMode,omitempty"`
	CodexReasoningEffort           string                  `json:"codexReasoningEffort,omitempty"`
	CodexSandboxMode               string                  `json:"codexSandboxMode,omitempty"`
	CodexApprovalPolicy            string                  `json:"codexApprovalPolicy,omitempty"`
	CodexSpeed                     string                  `json:"codexSpeed,omitempty"`
	Prompt                         string                  `json:"prompt"`
	// Title names the session; empty: the start of the prompt.
	Title                 string           `json:"title,omitempty"`
	Attachments           []ChatAttachment `json:"attachments,omitempty"`
	ProfileTransitionNote string           `json:"profileTransitionNote,omitempty"`
	ImportedContext       string           `json:"importedContext,omitempty"`
	ParentSessionID       string           `json:"parentSessionId,omitempty"`
	IssueID               string           `json:"issueId,omitempty"`
	// ForkSessionID starts the session from a copy of another session's
	// native history; neither writes into the other's transcript.
	ForkSessionID string `json:"forkSessionId,omitempty"`
	// ChatID continues a device's native chat: the session adopts it.
	ChatID string `json:"chatId,omitempty"`
	// Verification requests a read-only utility verifier session.
	Verification bool   `json:"verification,omitempty"`
	Source       string `json:"source"`
	// InputID names the first input, as SendAgentSessionInput.InputID does.
	InputID string `json:"inputId,omitempty"`
	// ReportBack false keeps an agent's child from reporting its ended
	// turns to its parent's inbox; unset reports them (DEV-090).
	ReportBack *bool `json:"reportBack,omitempty"`
	// FeishuRouteID is the Feishu chat route a topic's session starts
	// from: its chat's and bot's default agents apply.
	FeishuRouteID string `json:"-"`
}

// ValidSessionInputID reports whether a client may name an input this way:
// a lowercase canonical UUID. Input ids become event ids and Claude's
// native message uuid, and a transcript recognises them by that form.
func ValidSessionInputID(id string) bool {
	if len(id) != 36 {
		return false
	}
	for index, char := range id {
		switch index {
		case 8, 13, 18, 23:
			if char != '-' {
				return false
			}
		default:
			if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
				return false
			}
		}
	}
	return true
}
