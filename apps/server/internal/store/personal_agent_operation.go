package store

import "context"

// PersonalAgentOperation is a durable dispatch instruction, not a copy of
// live session state. InputID joins it to the authoritative native receipt.
type PersonalAgentOperation struct {
	ID              string `json:"id"`
	UserID          string `json:"-"`
	ItemID          string `json:"itemId"`
	IntentRevision  int64  `json:"intentRevision"`
	StepKey         string `json:"stepKey"`
	WorkspaceID     string `json:"workspaceId"`
	SourceInputID   string `json:"sourceInputId,omitempty"`
	SourceSessionID string `json:"sourceSessionId"`
	ReplaceOwner    bool   `json:"replaceOwner,omitempty"`
	TargetSessionID string `json:"targetSessionId,omitempty"`
	InputID         string `json:"inputId"`
	Prompt          string `json:"prompt"`
	RequestHash     string `json:"-"`
	SnapshotID      string `json:"snapshotId,omitempty"`
	Status          string `json:"status"`
	Reason          string `json:"reason,omitempty"`
	SessionID       string `json:"sessionId,omitempty"`
	Revision        int64  `json:"revision"`
	LeaseUntil      string `json:"-"`
	CreatedAt       string `json:"createdAt"`
	UpdatedAt       string `json:"updatedAt"`
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
