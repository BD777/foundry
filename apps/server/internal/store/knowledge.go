package store

// KnowledgeDocument is an on-device source revision. The control database
// keeps its hash and provenance; its body is only in transit during file RPC.
type KnowledgeDocument struct {
	ID            string `json:"id"`
	Revision      int64  `json:"revision"`
	OperationID   string `json:"operationId"`
	Hash          string `json:"hash"`
	Body          string `json:"body"`
	Deleted       bool   `json:"deleted"`
	SourceRef     string `json:"sourceRef"`
	SourceVersion string `json:"sourceVersion,omitempty"`
	ExpiresAt     string `json:"expiresAt,omitempty"`
	UpdatedAt     string `json:"updatedAt"`
}
type KnowledgeCommand struct {
	ExpectedControlRevision *int64             `json:"expectedControlRevision,omitempty"`
	ImportDocument          *KnowledgeDocument `json:"importDocument,omitempty"`
	WorkspaceID             string             `json:"workspaceId"`
	RootPath                string             `json:"rootPath"`
	VaultID                 string             `json:"vaultId"`
	Epoch                   int64              `json:"epoch"`
	Action                  string             `json:"action"`
	OperationID             string             `json:"operationId"`
	DocumentID              string             `json:"documentId,omitempty"`
	ExpectedRevision        *int64             `json:"expectedRevision,omitempty"`
	MinimumRevision         int64              `json:"minimumRevision,omitempty"`
	ExpectedRawHash         string             `json:"expectedRawHash,omitempty"`
	ExpectedHash            string             `json:"expectedHash,omitempty"`
	Body                    string             `json:"body,omitempty"`
	SourceRef               string             `json:"sourceRef,omitempty"`
	SourceVersion           string             `json:"sourceVersion,omitempty"`
	ExpiresAt               string             `json:"expiresAt,omitempty"`
	Staged                  bool               `json:"staged,omitempty"`
}
type KnowledgeSourceReview struct {
	RawHash    string `json:"rawHash"`
	RawContent string `json:"rawContent"`
	Body       string `json:"body"`
}
type KnowledgeReply struct {
	Review             *KnowledgeSourceReview `json:"review,omitempty"`
	ControlRevision    int64                  `json:"controlRevision"`
	ControlOperationID string                 `json:"controlOperationId"`
	VaultID            string                 `json:"vaultId"`
	Epoch              int64                  `json:"epoch"`
	State              string                 `json:"state"`
	OperationID        string                 `json:"operationId"`
	Document           *KnowledgeDocument     `json:"document,omitempty"`
	Documents          []KnowledgeDocument    `json:"documents,omitempty"`
	Error              string                 `json:"error,omitempty"`
	Code               string                 `json:"code,omitempty"`
}
