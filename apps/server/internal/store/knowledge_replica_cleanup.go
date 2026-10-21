package store

import "context"

type KnowledgeReplicaForget struct {
	ID         string `json:"id"`
	UserID     string `json:"-"`
	ReplicaID  string `json:"replicaId"`
	VaultID    string `json:"vaultId"`
	EntryID    string `json:"entryId"`
	State      string `json:"state"`
	Reason     string `json:"reason,omitempty"`
	Revision   int64  `json:"revision"`
	LeaseUntil string `json:"-"`
}
type KnowledgeReplicaCleanupStore interface {
	EnsureKnowledgeReplicaForgets(context.Context) error
	DueKnowledgeReplicaForgets(context.Context, string) ([]KnowledgeReplicaForget, error)
	ListKnowledgeReplicaForgets(context.Context, string) ([]KnowledgeReplicaForget, error)
	SaveKnowledgeReplicaForget(context.Context, KnowledgeReplicaForget) (KnowledgeReplicaForget, error)
}
