package store

import "context"

// KnowledgeVault is control-plane location/ownership metadata. It is not a
// workspace and contains no editable knowledge body or provider credential.
type KnowledgeVault struct {
	ID          string `json:"id"`
	UserID      string `json:"-"`
	Kind        string `json:"kind"`
	WorkspaceID string `json:"workspaceId"`
	DeviceID    string `json:"deviceId"`
	RootPath    string `json:"rootPath"`
	Epoch       int64  `json:"epoch"`
	Revision    int64  `json:"revision"`
	State       string `json:"state"`
	Reason      string `json:"reason,omitempty"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

type KnowledgeVaultStore interface {
	ResetPendingKnowledgeVault(context.Context, KnowledgeVault) (KnowledgeVault, error)
	CreateKnowledgeVault(context.Context, KnowledgeVault) (KnowledgeVault, error)
	GetKnowledgeVault(context.Context, string, string) (KnowledgeVault, error)
	ListKnowledgeVaults(context.Context, string) ([]KnowledgeVault, error)
	SaveKnowledgeVault(context.Context, KnowledgeVault) (KnowledgeVault, error)
	PendingKnowledgeVaults(context.Context) ([]KnowledgeVault, error)
}
