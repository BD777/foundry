package store

// AgentBackgroundTask is work a session's agent left running in the
// background (Claude only). Session events never carry its command line;
// members read it, redacted, with the task's output.
type AgentBackgroundTask struct {
	ID                  string `json:"id"`
	Provider            string `json:"provider"`
	Kind                string `json:"kind"`
	Description         string `json:"description"`
	Command             string `json:"command,omitempty"`
	Status              string `json:"status"`
	ExitCode            *int64 `json:"exitCode,omitempty"`
	StopReason          string `json:"stopReason,omitempty"`
	StartedAt           string `json:"startedAt"`
	EndedAt             string `json:"endedAt,omitempty"`
	TimeLimitMs         *int64 `json:"timeLimitMs,omitempty"`
	OwnerSubagentTaskID string `json:"ownerSubagentTaskId,omitempty"`
	ToolUseID           string `json:"toolUseId,omitempty"`
	Summary             string `json:"summary,omitempty"`
	HasOutput           bool   `json:"hasOutput"`
}

// AgentBackgroundTaskOutput is the end of a background task's output as
// its device read it: plain text, secrets redacted.
type AgentBackgroundTaskOutput struct {
	SessionID string `json:"sessionId"`
	TaskID    string `json:"taskId"`
	Command   string `json:"command,omitempty"`
	Content   string `json:"content"`
	Truncated bool   `json:"truncated"`
	Bytes     int64  `json:"bytes"`
	Kind      string `json:"kind"`
	// From is set when Content continues an earlier read: what the log
	// gained from that read's LineEnd on.
	From *int64 `json:"from,omitempty"`
	// LineEnd is where a later read continues; Stable is how many characters
	// of Content cover the log before it (the rest is an unfinished line).
	LineEnd *int64 `json:"lineEnd,omitempty"`
	Stable  *int64 `json:"stable,omitempty"`
	// Following: the device tells when this running task's log grows.
	Following bool `json:"following,omitempty"`
}

// AgentContextUsage is the session's context as its runtime reports it:
// InputTokens is the whole input of the latest main-agent model request,
// cache reads and writes included.
type AgentContextUsage struct {
	InputTokens   *int64                  `json:"inputTokens,omitempty"`
	ContextWindow *int64                  `json:"contextWindow,omitempty"`
	Model         string                  `json:"model,omitempty"`
	Compaction    *AgentContextCompaction `json:"compaction,omitempty"`
	// ConfiguredWindow is the window Foundry set for a compatible endpoint's
	// model and where it came from; the runtime may report another.
	ConfiguredWindow *ConfiguredContextWindow `json:"configuredWindow,omitempty"`
}

// ConfiguredContextWindow is a window Foundry set: the person's setting, the
// endpoint catalog, the official model, or the 1M default.
type ConfiguredContextWindow struct {
	Tokens int64  `json:"tokens"`
	Source string `json:"source"`
}

// AgentContextCompaction marks the runtime compacting the context.
type AgentContextCompaction struct {
	Trigger   string `json:"trigger"`
	PreTokens *int64 `json:"preTokens,omitempty"`
	// PostTokens and Summary, when the runtime gives them (DEV-083): what
	// is left of the context and the summary the agent continues from.
	PostTokens *int64 `json:"postTokens,omitempty"`
	Summary    string `json:"summary,omitempty"`
}

// SubagentUsage is a subagent's own work as Claude reports it: one token
// total, without an input/output split.
type SubagentUsage struct {
	TotalTokens int64 `json:"totalTokens"`
	ToolUses    int64 `json:"toolUses"`
	DurationMs  int64 `json:"durationMs"`
}

type AgentTurnUsage struct {
	DurationMs       int64  `json:"durationMs"`
	InputTokens      int64  `json:"inputTokens"`
	CacheReadTokens  int64  `json:"cacheReadTokens"`
	CacheWriteTokens int64  `json:"cacheWriteTokens"`
	OutputTokens     int64  `json:"outputTokens"`
	ReasoningTokens  *int64 `json:"reasoningTokens,omitempty"`
	ModelRequests    *int64 `json:"modelRequests,omitempty"`
	// CostUSD is what Claude priced the turn at (list price), when known.
	CostUSD *float64 `json:"costUsd,omitempty"`
}

type AgentSubagentTranscriptMessage struct {
	Content string `json:"content"`
	ID      string `json:"id"`
	Role    string `json:"role"`
	Title   string `json:"title,omitempty"`
	Kind    string `json:"kind,omitempty"`
	CallID  string `json:"callId,omitempty"`
	Status  string `json:"status,omitempty"`
	// RequestUsage is the tokens of the subagent's model request behind it.
	RequestUsage *ModelRequestUsage `json:"requestUsage,omitempty"`
}

type AgentSubagentTranscript struct {
	Messages     []AgentSubagentTranscriptMessage `json:"messages"`
	Prompt       string                           `json:"prompt,omitempty"`
	SessionID    string                           `json:"sessionId"`
	Status       string                           `json:"status"`
	SubagentType string                           `json:"subagentType,omitempty"`
	TaskID       string                           `json:"taskId"`
	Title        string                           `json:"title"`
	ToolUseID    string                           `json:"toolUseId"`
	Usage        *SubagentUsage                   `json:"usage,omitempty"`
}

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
// fingerprints (SubagentResponseFingerprint, distinct, in order), without
// its prompt.
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
