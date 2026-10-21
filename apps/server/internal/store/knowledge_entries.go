package store

import "context"

// KnowledgeEntry is a rebuildable index of a file authority. State also
// carries a control-plane revocation fence, which applies before file cleanup.
type KnowledgeEntry struct {
	ID            string `json:"id"`
	VaultID       string `json:"vaultId"`
	Epoch         int64  `json:"epoch"`
	Revision      int64  `json:"revision"`
	Hash          string `json:"hash"`
	Title         string `json:"title"`
	SourceRef     string `json:"sourceRef"`
	SourceVersion string `json:"sourceVersion,omitempty"`
	ExpiresAt     string `json:"expiresAt,omitempty"`
	State         string `json:"state"`
	UpdatedAt     string `json:"updatedAt"`
}

type KnowledgeMutation struct {
	ResultHash       string `json:"resultHash,omitempty"`
	ResultRevision   int64  `json:"resultRevision,omitempty"`
	ID               string `json:"id"`
	UserID           string `json:"-"`
	VaultID          string `json:"vaultId"`
	EntryID          string `json:"entryId"`
	Epoch            int64  `json:"epoch"`
	Action           string `json:"action"`
	ExpectedRevision int64  `json:"expectedRevision"`
	ExpectedRawHash  string `json:"expectedRawHash,omitempty"`
	ExpectedHash     string `json:"expectedHash"`
	Title            string `json:"title"`
	SourceRef        string `json:"sourceRef"`
	SourceVersion    string `json:"sourceVersion,omitempty"`
	ExpiresAt        string `json:"expiresAt,omitempty"`
	Body             string `json:"-"`
	RequestHash      string `json:"-"`
	Status           string `json:"status"`
	Reason           string `json:"reason,omitempty"`
	Revision         int64  `json:"revision"`
	LeaseUntil       string `json:"-"`
	CreatedAt        string `json:"createdAt"`
	UpdatedAt        string `json:"updatedAt"`
}

type KnowledgeEntryStore interface {
	ReconcileKnowledgeIndex(context.Context, string, string, int64, []KnowledgeDocument) error
	ListKnowledgeEntries(context.Context, string, string) ([]KnowledgeEntry, error)
	GetKnowledgeEntry(context.Context, string, string, string) (KnowledgeEntry, error)
	CaptureKnowledgeMutation(context.Context, KnowledgeMutation) (KnowledgeMutation, error)
	GetKnowledgeMutation(context.Context, string, string) (KnowledgeMutation, error)
	ListKnowledgeMutations(context.Context, string) ([]KnowledgeMutation, error)
	DueKnowledgeMutations(context.Context, string) ([]KnowledgeMutation, error)
	SaveKnowledgeMutation(context.Context, KnowledgeMutation) (KnowledgeMutation, error)
	CompleteKnowledgeMutation(context.Context, KnowledgeMutation, KnowledgeDocument) error
}
