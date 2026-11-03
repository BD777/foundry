package store

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
