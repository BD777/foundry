package store

import (
	"context"
	"fmt"
)

// PersonalAgentOperation is a durable dispatch instruction, not a copy of
// live session state. InputID joins it to the authoritative native receipt.
type PersonalAgentOperation struct {
	ID     string `json:"id"`
	UserID string `json:"-"`
	// AssistantID is the assistant the record belongs to (DEV-191).
	AssistantID     string `json:"-"`
	ItemID          string `json:"itemId"`
	IntentRevision  int64  `json:"intentRevision"`
	StepKey         string `json:"stepKey"`
	WorkspaceID     string `json:"workspaceId"`
	SourceInputID   string `json:"sourceInputId,omitempty"`
	SourceSessionID string `json:"sourceSessionId"`
	ReplaceOwner    bool   `json:"replaceOwner,omitempty"`
	TargetSessionID string `json:"targetSessionId,omitempty"`
	ExecutionChoice string `json:"executionChoice,omitempty"`
	// ReadOnly is the dispatcher's word that the step changes nothing in
	// its workspace: it starts beside the workspace's writer instead of
	// waiting for it (DEV-229).
	ReadOnly    bool   `json:"readOnly,omitempty"`
	InputID     string `json:"inputId"`
	Prompt      string `json:"prompt"`
	RequestHash string `json:"-"`
	SnapshotID  string `json:"snapshotId,omitempty"`
	Status      string `json:"status"`
	Reason      string `json:"reason,omitempty"`
	SessionID   string `json:"sessionId,omitempty"`
	// While a write step waits for its workspace's writer: since when, the
	// session writing there and since when it has been, and when the
	// dispatching session was told (DEV-229).
	WaitingSince   string `json:"waitingSince,omitempty"`
	BusySessionID  string `json:"busySessionId,omitempty"`
	BusySince      string `json:"busySince,omitempty"`
	QueuedNoticeAt string `json:"queuedNoticeAt,omitempty"`
	Revision       int64  `json:"revision"`
	LeaseUntil     string `json:"-"`
	CreatedAt      string `json:"createdAt"`
	UpdatedAt      string `json:"updatedAt"`
}

type PersonalAgentOperationStore interface {
	CancelPendingPersonalAgentOperation(context.Context, string, string, int64) (PersonalAgentOperation, error)
	CancelUndispatchedPersonalAgentOperations(context.Context, string) error
	CapturePersonalAgentOperation(context.Context, PersonalAgentOperation) (PersonalAgentOperation, error)
	GetPersonalAgentOperation(context.Context, string, string) (PersonalAgentOperation, error)
	ListPersonalAgentOperations(context.Context, string) ([]PersonalAgentOperation, error)
	DuePersonalAgentOperations(context.Context, string, int) ([]PersonalAgentOperation, error)
	SavePersonalAgentOperation(context.Context, PersonalAgentOperation) (PersonalAgentOperation, error)
}

// WorkspaceWriterBusyError refuses a write step's input while another
// session may be writing in its workspace: SessionID, running since Since,
// or (Unsettled) an earlier dispatched input whose end is not yet known.
type WorkspaceWriterBusyError struct {
	SessionID string
	Since     string
	Unsettled bool
}

func (e *WorkspaceWriterBusyError) Error() string {
	if e.Unsettled {
		return "workspace_writer_busy: an earlier input still needs its native end receipt"
	}
	return fmt.Sprintf("workspace_writer_busy: session %s has been running since %s; reuse or wait for the existing owner", e.SessionID, e.Since)
}
