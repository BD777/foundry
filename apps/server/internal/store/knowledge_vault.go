package store

import "context"

// KnowledgeVault is control-plane location/ownership metadata. It is not a
// workspace and contains no editable knowledge body or provider credential.
type KnowledgeVault struct {
	ID     string `json:"id"`
	UserID string `json:"-"`
	// AssistantID is the assistant whose memory layer this is (Scope
	// assistant); empty for the person's layer and for domain knowledge.
	AssistantID string `json:"assistantId,omitempty"`
	// Scope is a memory vault's layer (MemoryScopePerson or
	// MemoryScopeAssistant, DEV-191 P2); empty for domain knowledge.
	Scope       string `json:"scope,omitempty"`
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

// The layers of a person's memory (DEV-191 P2). An assistant recalls the
// person's layer, which every assistant of theirs shares, and its own,
// which no other assistant reads.
const (
	MemoryScopePerson    = "person"
	MemoryScopeAssistant = "assistant"
)

type KnowledgeVaultStore interface {
	ResetPendingKnowledgeVault(context.Context, KnowledgeVault) (KnowledgeVault, error)
	CreateKnowledgeVault(context.Context, KnowledgeVault) (KnowledgeVault, error)
	GetKnowledgeVault(context.Context, string, string) (KnowledgeVault, error)
	ListKnowledgeVaults(context.Context, string) ([]KnowledgeVault, error)
	SaveKnowledgeVault(context.Context, KnowledgeVault) (KnowledgeVault, error)
	PendingKnowledgeVaults(context.Context) ([]KnowledgeVault, error)
}
