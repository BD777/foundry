package store

import "context"

// A move keeps the old source frozen until the verified destination owns the
// next epoch. Metadata and hashes are durable; copied bodies are streamed.
type KnowledgeMigration struct {
	ID                    string              `json:"id"`
	UserID                string              `json:"-"`
	VaultID               string              `json:"vaultId"`
	Source                KnowledgeVault      `json:"source"`
	Target                KnowledgeVault      `json:"target"`
	Revision              int64               `json:"revision"`
	State                 string              `json:"state"`
	Reason                string              `json:"reason,omitempty"`
	CancelRequested       bool                `json:"cancelRequested"`
	Cursor                int                 `json:"cursor"`
	Manifest              []KnowledgeDocument `json:"manifest,omitempty"`
	SourceControlRevision int64               `json:"sourceControlRevision"`
	TargetControlRevision int64               `json:"targetControlRevision"`
	LeaseUntil            string              `json:"-"`
	CreatedAt             string              `json:"createdAt"`
	UpdatedAt             string              `json:"updatedAt"`
}

// Known copies remain discoverable after a move or a canceled staging attempt.
// They never authorize reads. Forgetting must propagate to each of them.
type KnowledgeReplica struct {
	ID        string         `json:"id"`
	UserID    string         `json:"-"`
	VaultID   string         `json:"vaultId"`
	Location  KnowledgeVault `json:"location"`
	CreatedAt string         `json:"createdAt"`
}

type KnowledgeMigrationStore interface {
	BeginKnowledgeMigration(context.Context, KnowledgeMigration, int64) (KnowledgeMigration, error)
	GetKnowledgeMigration(context.Context, string, string) (KnowledgeMigration, error)
	ListKnowledgeMigrations(context.Context, string) ([]KnowledgeMigration, error)
	DueKnowledgeMigrations(context.Context, string) ([]KnowledgeMigration, error)
	SaveKnowledgeMigration(context.Context, KnowledgeMigration) (KnowledgeMigration, error)
	RequestKnowledgeMigrationCancel(context.Context, string, string, int64) (KnowledgeMigration, error)
	SwitchKnowledgeAuthority(context.Context, KnowledgeMigration) (KnowledgeMigration, error)
	ActivateKnowledgeAuthority(context.Context, KnowledgeMigration) (KnowledgeMigration, error)
	AbortKnowledgeMigration(context.Context, KnowledgeMigration) (KnowledgeMigration, error)
	ListKnowledgeReplicas(context.Context, string, string) ([]KnowledgeReplica, error)
}
