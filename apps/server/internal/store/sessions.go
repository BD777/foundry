package store

// SessionTokenIdentity is the resolved actor behind a valid agent session
// bearer token. AccountID is reserved for the upcoming accounts system.
type SessionTokenIdentity struct {
	SessionID   string `json:"sessionId"`
	WorkspaceID string `json:"workspaceId"`
	DeviceID    string `json:"deviceId"`
	AccountID   string `json:"accountId,omitempty"`
	// LeaseID is set for a lease's command token (MintLeaseCommandToken):
	// it acts for the session on that one compute lease and nothing else.
	LeaseID string `json:"leaseId,omitempty"`
}

// AgentSessionRoleIssueExecution is the session that implements an Issue.
const AgentSessionRoleIssueExecution = "issue_execution"

// AgentSessionRoleIssueClarification is the Issue's clarification
// conversation: one read-only session in the Issue's workspace whose every
// message from the person is a new input.
const AgentSessionRoleIssueClarification = "issue_clarification"

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
	CreatedByUserID                string                  `json:"-"`
	WorkspaceID                    string                  `json:"workspaceId"`
	NativeSessionID                string                  `json:"nativeSessionId,omitempty"`
	AgentID                        string                  `json:"agentId"`
	Provider                       string                  `json:"provider"`
	ProfileID                      string                  `json:"profileId,omitempty"`
	Model                          string                  `json:"model,omitempty"`
	WorkerGroupID                  string                  `json:"workerGroupId,omitempty"`
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
