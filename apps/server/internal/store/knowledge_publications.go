package store

import "context"

// A publication is a revocable, version-pinned reference. It contains no
// copied source body and grants no workspace or session control permission.
type KnowledgePublication struct {
	// Derived for a person-facing read; never an authorization source.
	NeedsReview        bool   `json:"needsReview,omitempty"`
	Scope              string `json:"scope"`
	ID                 string `json:"id"`
	UserID             string `json:"-"`
	VaultID            string `json:"vaultId"`
	EntryID            string `json:"entryId"`
	SourceEpoch        int64  `json:"sourceEpoch"`
	SourceRevision     int64  `json:"sourceRevision"`
	SourceHash         string `json:"sourceHash"`
	TargetWorkspaceID  string `json:"targetWorkspaceId"`
	ProfileID          string `json:"profileId"`
	ProviderConfigHash string `json:"providerConfigHash,omitempty"`
	ProfileFingerprint string `json:"profileFingerprint"`
	AudienceHash       string `json:"audienceHash"`
	Purpose            string `json:"purpose"`
	ExpiresAt          string `json:"expiresAt,omitempty"`
	State              string `json:"state"`
	Revision           int64  `json:"revision"`
	CreatedAt          string `json:"createdAt"`
	UpdatedAt          string `json:"updatedAt"`
}

type KnowledgePublicationStore interface {
	CreateKnowledgePublication(context.Context, KnowledgePublication) (KnowledgePublication, error)
	GetKnowledgePublication(context.Context, string, string) (KnowledgePublication, error)
	ListKnowledgePublications(context.Context, string) ([]KnowledgePublication, error)
	RevokeKnowledgePublication(context.Context, string, string, int64) (KnowledgePublication, error)
}
