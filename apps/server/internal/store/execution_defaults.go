package store

import (
	"context"
	"errors"
)

// StoredExecutionModelDefault is one person's choice of the model their
// orchestrator hands execution work to. An empty WorkspaceID is the global
// choice; a set one overrides it in that workspace.
type StoredExecutionModelDefault struct {
	OwnerUserID   string                 `json:"-"`
	WorkspaceID   string                 `json:"-"`
	ProviderKind  string                 `json:"providerKind,omitempty"`
	ProviderID    string                 `json:"providerId"`
	Runtime       string                 `json:"runtime"`
	Model         string                 `json:"model"`
	WorkerGroupID string                 `json:"workerGroupId,omitempty"`
	Effort        string                 `json:"effort,omitempty"`
	Alternatives  []ExecutionModelChoice `json:"alternatives"`
	Scope         string                 `json:"scope"`
	UpdatedBy     string                 `json:"updatedBy,omitempty"`
	UpdatedAt     string                 `json:"updatedAt,omitempty"`
}

var ErrExecutionDefaultNotFound = errors.New("execution default not found")

type ExecutionDefaultStore interface {
	GetExecutionDefault(ctx context.Context, ownerUserID, workspaceID string) (StoredExecutionModelDefault, error)
	SetExecutionDefault(ctx context.Context, value StoredExecutionModelDefault) error
}
