package store

import "context"

// A role override is a whole run preference, copied from the default when the
// user enables it. An absent override inherits; an empty account never means
// "try every provider". DeviceID empty means the target workspace's device.
type PersonalAgentRunPreference struct {
	DeviceID       string                   `json:"deviceId,omitempty"`
	ProfileID      string                   `json:"profileId,omitempty"`
	Runtime        string                   `json:"runtime,omitempty"`
	Model          string                   `json:"model,omitempty"`
	Effort         string                   `json:"effort,omitempty"`
	Disabled       bool                     `json:"disabled,omitempty"`
	TokenBudget    int64                    `json:"tokenBudget,omitempty"`
	TimeoutMinutes int                      `json:"timeoutMinutes,omitempty"`
	Fallbacks      []PersonalAgentRunTarget `json:"fallbacks,omitempty"`
}

type PersonalAgentRunTarget struct {
	DeviceID     string   `json:"deviceId"`
	ProfileID    string   `json:"profileId"`
	Runtime      string   `json:"runtime"`
	Model        string   `json:"model,omitempty"`
	Effort       string   `json:"effort,omitempty"`
	WorkspaceIDs []string `json:"workspaceIds"`
}

// Snapshot records requested configuration. Actual native model/effort remain
// session observations; an unreported value is never inferred from this row.
type PersonalAgentRunSnapshot struct {
	AccountLabel       string `json:"accountLabel,omitempty"`
	InputID            string `json:"inputId"`
	ID                 string `json:"id"`
	UserID             string `json:"-"`
	Role               string `json:"role"`
	WorkspaceID        string `json:"workspaceId"`
	DeviceID           string `json:"deviceId"`
	Runtime            string `json:"runtime"`
	ProfileID          string `json:"profileId"`
	AgentID            string `json:"agentId,omitempty"`
	Model              string `json:"model,omitempty"`
	Effort             string `json:"effort,omitempty"`
	ProfileFingerprint string `json:"profileFingerprint,omitempty"`
	ProviderConfigHash string `json:"providerConfigHash,omitempty"`
	ProviderOrigin     string `json:"providerOrigin,omitempty"`
	ConfigHash         string `json:"configHash"`
	TokenBudget        int64  `json:"tokenBudget"`
	TimeoutMinutes     int    `json:"timeoutMinutes"`
	SelectionReason    string `json:"selectionReason"`
	CreatedAt          string `json:"createdAt"`
	SessionID          string `json:"sessionId,omitempty"`
}

type PersonalAgentRunPreview struct {
	Role        string `json:"role"`
	WorkspaceID string `json:"workspaceId"`
}

type PersonalAgentRuntimeStore interface {
	GetPersonalAgentRunSnapshot(context.Context, string, string) (PersonalAgentRunSnapshot, error)
	RecordPersonalAgentRunSnapshot(context.Context, PersonalAgentRunSnapshot) (PersonalAgentRunSnapshot, error)
	BindPersonalAgentRunSnapshot(context.Context, string, string, string) error
	ListPersonalAgentRunSnapshots(context.Context, string, int) ([]PersonalAgentRunSnapshot, error)
}
