package store

import (
	"context"
	"errors"
)

var ErrModelNoteNotFound = errors.New("model note not found")

const MaxModelNoteBody = 12000

// StoredModelNote is one thing an orchestrator learned about handing work to a
// provider's model. Appends keep earlier observations instead of replacing
// them.
type StoredModelNote struct {
	ID              string `json:"id"`
	OwnerUserID     string `json:"-"`
	ProviderKind    string `json:"providerKind"`
	ProviderID      string `json:"providerId"`
	Runtime         string `json:"runtime"`
	Model           string `json:"model"`
	Body            string `json:"body"`
	AuthorUserID    string `json:"authorUserId"`
	AuthorName      string `json:"authorName"`
	AuthorSessionID string `json:"authorSessionId,omitempty"`
	CreatedAt       string `json:"createdAt"`
	UpdatedAt       string `json:"updatedAt,omitempty"`
}

type ModelNoteFilter struct {
	OwnerUserID  string
	ProviderKind string
	ProviderID   string
	Runtime      string
	Model        string
	Offset       int
	Limit        int
}

type ModelNoteStore interface {
	ListModelNotes(ctx context.Context, filter ModelNoteFilter) ([]StoredModelNote, int, error)
	GetModelNote(ctx context.Context, id string) (StoredModelNote, error)
	AppendModelNote(ctx context.Context, note StoredModelNote) (StoredModelNote, error)
	UpdateModelNote(ctx context.Context, id, ownerUserID, body string) (StoredModelNote, error)
	DeleteModelNote(ctx context.Context, id, ownerUserID string) error
}

// StoredExecutionModelDefault is one person's choice of the model their
// orchestrator hands execution work to. An empty WorkspaceID is the global
// choice; a set one overrides it in that workspace.
type StoredExecutionModelDefault struct {
	OwnerUserID  string `json:"-"`
	WorkspaceID  string `json:"-"`
	ProviderKind string `json:"providerKind,omitempty"`
	ProviderID   string `json:"providerId"`
	Runtime      string `json:"runtime"`
	Model        string `json:"model"`
	ModelPoolID  string `json:"modelPoolId,omitempty"`
	Effort       string `json:"effort,omitempty"`
	Scope        string `json:"scope"`
	UpdatedBy    string `json:"updatedBy,omitempty"`
	UpdatedAt    string `json:"updatedAt,omitempty"`
}

var ErrExecutionDefaultNotFound = errors.New("execution default not found")

type ExecutionDefaultStore interface {
	GetExecutionDefault(ctx context.Context, ownerUserID, workspaceID string) (StoredExecutionModelDefault, error)
	SetExecutionDefault(ctx context.Context, value StoredExecutionModelDefault) error
}
