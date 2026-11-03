package store

type AgentSubagentSummary struct {
	Prompt        string         `json:"prompt,omitempty"`
	ResponseTexts []string       `json:"responseTexts"`
	SessionID     string         `json:"sessionId"`
	Status        string         `json:"status"`
	SubagentType  string         `json:"subagentType,omitempty"`
	TaskID        string         `json:"taskId"`
	Title         string         `json:"title"`
	ToolUseID     string         `json:"toolUseId"`
	Usage         *SubagentUsage `json:"usage,omitempty"`
}

// AgentSubagentDigest is a subagent as a chat lists it: its answers only as
// fingerprints (the protocol's subagentResponseFingerprint, distinct, in
// order), without its prompt.
type AgentSubagentDigest struct {
	ResponseFingerprints []string       `json:"responseFingerprints"`
	SessionID            string         `json:"sessionId"`
	Status               string         `json:"status"`
	SubagentType         string         `json:"subagentType,omitempty"`
	TaskID               string         `json:"taskId"`
	Title                string         `json:"title"`
	ToolUseID            string         `json:"toolUseId"`
	Usage                *SubagentUsage `json:"usage,omitempty"`
}
