package store

type RunEvent struct {
	ID     string `json:"id"`
	RunID  string `json:"runId"`
	At     string `json:"at"`
	Label  string `json:"label"`
	Detail string `json:"detail"`
	Level  string `json:"level"`
}

type AcceptanceArtifact struct {
	ID         string `json:"id"`
	IssueID    string `json:"issueId"`
	Kind       string `json:"kind"`
	Title      string `json:"title"`
	Summary    string `json:"summary"`
	PrimaryURI string `json:"primaryUri,omitempty"`
}

type Run struct {
	EnvironmentID       string     `json:"environmentId,omitempty"`
	EnvironmentRevision int        `json:"environmentRevision,omitempty"`
	ExecutionCwd        string     `json:"executionCwd,omitempty"`
	Error               string     `json:"error,omitempty"`
	ID                  string     `json:"id"`
	IssueID             string     `json:"issueId"`
	WorkspaceID         string     `json:"workspaceId,omitempty"`
	Status              string     `json:"status"`
	Runtime             string     `json:"runtime"`
	StartedLabel        string     `json:"startedLabel"`
	StartedAt           string     `json:"startedAt,omitempty"`
	CompletedAt         string     `json:"completedAt,omitempty"`
	Events              []RunEvent `json:"events"`
}

type IssueConversationMessage struct {
	ID        string `json:"id"`
	Role      string `json:"role"`
	Text      string `json:"text"`
	RunID     string `json:"runId,omitempty"`
	CreatedAt string `json:"createdAt"`
	// Via names where a person's message came from when not the web, such
	// as "feishu".
	Via string `json:"via,omitempty"`
}

// IssueClarification is the Issue's clarification session and the state of
// the person's latest message to it.
type IssueClarification struct {
	SessionID string `json:"sessionId"`
	// Status is "replying" while the Agent answers the latest message,
	// "failed" when it could not, and "answered" once its reply is recorded.
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
	// InputID is the session input carrying the latest message.
	InputID string `json:"inputId"`
	// MessageID is the person's latest message in the Issue conversation.
	MessageID string `json:"messageId"`
	// Revision and ContentDigest name the draft the message was about; a
	// proposal in the reply revises exactly that draft.
	Revision      int    `json:"revision"`
	ContentDigest string `json:"contentDigest"`
	ChangeReason  string `json:"changeReason"`
}

// ClarificationResponse is the clarification session's reply to one message.
type ClarificationResponse struct {
	Message         string           `json:"message"`
	ProposedContent *ContractContent `json:"proposedContent,omitempty"`
}

// ClarificationTurn travels with a clarification input: the draft the
// message is about and the conversation before it, for a session that has
// lost its native context.
type ClarificationTurn struct {
	Draft    IssueContract      `json:"draft"`
	Messages []ChatRecapMessage `json:"messages"`
	Message  string             `json:"message"`
}

// IssueQuestion is what an Issue's execution asked the person: something only
// they can decide (input) or allow (permission). The Issue is blocked on it
// once the execution's turn ends, and resumes in the same candidate with the
// answer.
type IssueQuestion struct {
	ID string `json:"id"`
	// Kind is "input" or "permission".
	Kind string `json:"kind"`
	Text string `json:"text"`
	// Options are choices the Agent offers; the person may answer otherwise.
	Options []string `json:"options,omitempty"`
	// RunID is the execution session that asked.
	RunID   string `json:"runId"`
	AskedAt string `json:"askedAt"`
}

type IssueBlockedReason struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

type Issue struct {
	// CreatedByUserID is the account that started it; agent-created sessions
	// inherit their parent's. Set by the server, never by clients.
	CreatedByUserID            string                     `json:"createdByUserId,omitempty"`
	ExecutionContract          *IssueContract             `json:"executionContract,omitempty"`
	ContractState              string                     `json:"contractState,omitempty"`
	CurrentContractRevision    *int                       `json:"currentContractRevision,omitempty"`
	DraftContractRevision      *int                       `json:"draftContractRevision,omitempty"`
	CurrentCandidateSnapshotID *string                    `json:"currentCandidateSnapshotId,omitempty"`
	CurrentReviewSnapshotID    *string                    `json:"currentReviewSnapshotId,omitempty"`
	VerificationSummary        *VerificationSummary       `json:"verificationSummary,omitempty"`
	BlockedReason              *IssueBlockedReason        `json:"blockedReason,omitempty"`
	CodexSpeed                 string                     `json:"codexSpeed,omitempty"`
	Model                      string                     `json:"model,omitempty"`
	ProfileID                  string                     `json:"profileId,omitempty"`
	ClaudeEffort               string                     `json:"claudeEffort,omitempty"`
	CodexReasoningEffort       string                     `json:"codexReasoningEffort,omitempty"`
	Messages                   []IssueConversationMessage `json:"messages,omitempty"`
	Clarification              *IssueClarification        `json:"clarification,omitempty"`
	Question                   *IssueQuestion             `json:"question,omitempty"`
	ID                         string                     `json:"id"`
	WorkspaceID                string                     `json:"workspaceId,omitempty"`
	ShortID                    string                     `json:"shortId"`
	Title                      string                     `json:"title"`
	Status                     string                     `json:"status"`
	Priority                   string                     `json:"priority"`
	Readiness                  string                     `json:"readiness,omitempty"`
	SourceInput                string                     `json:"sourceInput"`
	InferredTask               string                     `json:"inferredTask"`
	Runtime                    string                     `json:"runtime"`
	Skills                     []SkillPackRef             `json:"skills"`
	AcceptanceCriteria         []string                   `json:"acceptanceCriteria"`
	Checks                     []string                   `json:"checks"`
	Artifact                   *AcceptanceArtifact        `json:"artifact,omitempty"`
	Run                        *Run                       `json:"run,omitempty"`
	UpdatedLabel               string                     `json:"updatedLabel"`
}

type CreateIssueInput struct {
	CreatedByUserID      string `json:"-"`
	CodexSpeed           string `json:"codexSpeed,omitempty"`
	Model                string `json:"model,omitempty"`
	ProfileID            string `json:"profileId,omitempty"`
	ClaudeEffort         string `json:"claudeEffort,omitempty"`
	CodexReasoningEffort string `json:"codexReasoningEffort,omitempty"`
	WorkspaceID          string `json:"workspaceId,omitempty"`
	Title                string `json:"title"`
	SourceInput          string `json:"sourceInput"`
	Runtime              string `json:"runtime"`
}

type CompleteIssueInput struct {
	Canceled            bool               `json:"canceled,omitempty"`
	Response            string             `json:"response,omitempty"`
	EnvironmentID       string             `json:"environmentId,omitempty"`
	EnvironmentRevision int                `json:"environmentRevision,omitempty"`
	ExecutionCwd        string             `json:"executionCwd,omitempty"`
	Error               string             `json:"error,omitempty"`
	RunID               string             `json:"runId"`
	Artifact            AcceptanceArtifact `json:"artifact"`
	Checks              []string           `json:"checks"`
}
