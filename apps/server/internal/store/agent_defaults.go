package store

import "context"

// Default agents (DEV-068): which account, model and effort a session runs
// with when its start names no account. Each level may set any of the
// three; what it leaves unset falls through to the next. Most specific
// first: a Feishu chat's override, the workspace's Feishu bot, the
// workspace, then the person's own choice (httpapi/agent_defaults.go).

// AgentDefaultScope is the level a default is set at.
type AgentDefaultScope string

const (
	AgentDefaultWorkspace  AgentDefaultScope = "workspace"
	AgentDefaultFeishuBot  AgentDefaultScope = "feishu_bot"
	AgentDefaultFeishuChat AgentDefaultScope = "feishu_chat"
)

// ValidAgentDefaultScope reports whether scope is one a default is set at.
func ValidAgentDefaultScope(scope AgentDefaultScope) bool {
	switch scope {
	case AgentDefaultWorkspace, AgentDefaultFeishuBot, AgentDefaultFeishuChat:
		return true
	}
	return false
}

// AgentDefault is one level's default agent in a workspace.
type AgentDefault struct {
	WorkspaceID string            `json:"workspaceId"`
	Scope       AgentDefaultScope `json:"scope"`
	// RouteID is the Feishu chat route a feishu_chat default is for.
	RouteID string `json:"routeId,omitempty"`
	// ProfileID is the account; "" inherits it.
	ProfileID string `json:"profileId,omitempty"`
	// Runtime is the runtime the model and effort were chosen for: the
	// account's, or the inherited one's. They apply only to an account of
	// that runtime.
	Runtime string `json:"runtime,omitempty"`
	Model   string `json:"model,omitempty"`
	// Effort is Claude's effort or Codex's reasoning effort, by Runtime.
	Effort    string `json:"effort,omitempty"`
	UpdatedBy string `json:"updatedBy,omitempty"`
	UpdatedAt string `json:"updatedAt,omitempty"`
}

// Empty reports whether the default sets nothing: every field inherits.
func (d AgentDefault) Empty() bool {
	return d.ProfileID == "" && d.Model == "" && d.Effort == ""
}

// AgentDefaultStore keeps the default agents of workspaces and channels.
type AgentDefaultStore interface {
	// ListAgentDefaults lists the workspace's defaults: its own, its Feishu
	// bot's, and those of chats still routed to it.
	ListAgentDefaults(ctx context.Context, workspaceID string) ([]AgentDefault, error)
	// SetAgentDefault replaces one level's default; an empty one removes it.
	SetAgentDefault(ctx context.Context, value AgentDefault) error
}
