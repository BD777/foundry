package store

type CreateIssueInput struct {
	CreatedByUserID      string `json:"-"`
	CodexSpeed           string `json:"codexSpeed,omitempty"`
	Model                string `json:"model,omitempty"`
	ProfileID            string `json:"profileId,omitempty"`
	ClaudeEffort         string `json:"claudeEffort,omitempty"`
	CodexReasoningEffort string `json:"codexReasoningEffort,omitempty"`
	WorkspaceID          string `json:"workspaceId,omitempty"`
	Title                string `json:"title"`
	SourceInput          string `json:"sourceInput"`
	Runtime              string `json:"runtime"`
}
