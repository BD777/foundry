package store

type ProviderHealth struct {
	DeviceID     string     `json:"deviceId,omitempty"`
	Provider     string     `json:"provider"`
	Status       string     `json:"status"`
	AuthMode     string     `json:"authMode"`
	SecretStored string     `json:"secretStored"`
	AccountLabel string     `json:"accountLabel,omitempty"`
	StatusDetail string     `json:"statusDetail,omitempty"`
	Cli          *NativeCli `json:"cli,omitempty"`
	// OfficialSkills are the skills this agent ships itself; sessions on it
	// always have them, besides their workspace's selection.
	OfficialSkills []OfficialSkill `json:"officialSkills,omitempty"`
}

// OfficialSkill is a skill Claude Code or Codex ships itself.
type OfficialSkill struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// NativeCli is the device's own Claude Code / Codex program, which Foundry
// runs instead of shipping a copy.
type NativeCli struct {
	Installed      bool   `json:"installed"`
	Version        string `json:"version,omitempty"`
	MinimumVersion string `json:"minimumVersion,omitempty"`
	Outdated       bool   `json:"outdated,omitempty"`
	InstallCommand string `json:"installCommand,omitempty"`
	UpdateCommand  string `json:"updateCommand,omitempty"`
}

// NativeCliInstallResult is what running the official installer for a
// device's program produced.
type NativeCliInstallResult struct {
	Runtime string     `json:"runtime"`
	OK      bool       `json:"ok"`
	Command string     `json:"command"`
	Log     string     `json:"log"`
	Cli     *NativeCli `json:"cli,omitempty"`
}

type NativeAccountInspection struct {
	Runtime         string               `json:"runtime"`
	Source          string               `json:"source"`
	Sources         []string             `json:"sources"`
	ExecutionSource string               `json:"executionSource"`
	CheckedAt       string               `json:"checkedAt"`
	Status          string               `json:"status"`
	AccountLabel    string               `json:"accountLabel,omitempty"`
	Plan            string               `json:"plan,omitempty"`
	Message         string               `json:"message"`
	Usage           []NativeAccountUsage `json:"usage"`
}

type NativeAccountUsage struct {
	UsedPercent   float64  `json:"usedPercent"`
	WindowMinutes *float64 `json:"windowMinutes,omitempty"`
	ResetsAt      *float64 `json:"resetsAt,omitempty"`
}

type AgentProfileCheck struct {
	Status    string `json:"status"`
	CheckedAt string `json:"checkedAt,omitempty"`
	Message   string `json:"message,omitempty"`
}

type AgentProfileProjection struct {
	AccountLabel         string             `json:"accountLabel,omitempty"`
	ID                   string             `json:"id"`
	DeviceID             string             `json:"deviceId"`
	Runtime              string             `json:"runtime"`
	Label                string             `json:"label"`
	Fingerprint          string             `json:"fingerprint,omitempty"`
	Status               string             `json:"status"`
	AuthMode             string             `json:"authMode"`
	SecretStored         string             `json:"secretStored"`
	ServerCredential     bool               `json:"serverCredential,omitempty"`
	ConfigScope          string             `json:"configScope"`
	ConfigLabel          string             `json:"configLabel"`
	ConfigSection        string             `json:"configSection,omitempty"`
	Check                *AgentProfileCheck `json:"check,omitempty"`
	Shareable            bool               `json:"shareable,omitempty"`
	ConnectionType       string             `json:"connectionType"`
	Model                string             `json:"model,omitempty"`
	Models               []string           `json:"models,omitempty"`
	PromptPrefix         string             `json:"promptPrefix,omitempty"`
	ClaudeEffort         string             `json:"claudeEffort,omitempty"`
	ClaudePermissionMode string             `json:"claudePermissionMode,omitempty"`
	CodexReasoningEffort string             `json:"codexReasoningEffort,omitempty"`
	CodexSandboxMode     string             `json:"codexSandboxMode,omitempty"`
	CodexApprovalPolicy  string             `json:"codexApprovalPolicy,omitempty"`
	CodexSpeed           string             `json:"codexSpeed,omitempty"`
	BaseURL              string             `json:"baseUrl,omitempty"`
	CommandLabel         string             `json:"commandLabel,omitempty"`
	Origin               string             `json:"origin"`
	PromotedProfileID    string             `json:"promotedProfileId,omitempty"`
	LastSeenLabel        string             `json:"lastSeenLabel"`
	StatusDetail         string             `json:"statusDetail,omitempty"`
}

// ProfileDefinition is a control-plane owned profile. It carries no DeviceID
// and no status: reachability belongs to the device that runs it.
type ProfileDefinition struct {
	ID                   string   `json:"id"`
	Runtime              string   `json:"runtime"`
	Label                string   `json:"label"`
	AuthMode             string   `json:"authMode"`
	ConnectionType       string   `json:"connectionType"`
	BaseURL              string   `json:"baseUrl,omitempty"`
	Model                string   `json:"model,omitempty"`
	Models               []string `json:"models,omitempty"`
	PromptPrefix         string   `json:"promptPrefix,omitempty"`
	ClaudeEffort         string   `json:"claudeEffort,omitempty"`
	ClaudePermissionMode string   `json:"claudePermissionMode,omitempty"`
	CodexReasoningEffort string   `json:"codexReasoningEffort,omitempty"`
	CodexSandboxMode     string   `json:"codexSandboxMode,omitempty"`
	CodexApprovalPolicy  string   `json:"codexApprovalPolicy,omitempty"`
	CodexSpeed           string   `json:"codexSpeed,omitempty"`
	HasCredential        bool     `json:"hasCredential"`
	OwnerUserID          string   `json:"ownerUserId,omitempty"`
	UpdatedAtLabel       string   `json:"updatedAtLabel"`
}

// DeviceProfileBinding records which server profiles a device may run.
type DeviceProfileBinding struct {
	DeviceID  string `json:"deviceId"`
	ProfileID string `json:"profileId"`
	Enabled   bool   `json:"enabled"`
}

// SaveProfileInput creates or updates a server profile. APIKey is write-only:
// sealed on arrival, never read back. Omitting it keeps the stored credential.
type SaveProfileInput struct {
	ID                   string   `json:"id,omitempty"`
	Runtime              string   `json:"runtime"`
	Label                string   `json:"label"`
	AuthMode             string   `json:"authMode"`
	ConnectionType       string   `json:"connectionType"`
	BaseURL              string   `json:"baseUrl,omitempty"`
	Model                string   `json:"model,omitempty"`
	Models               []string `json:"models,omitempty"`
	PromptPrefix         string   `json:"promptPrefix,omitempty"`
	ClaudeEffort         string   `json:"claudeEffort,omitempty"`
	ClaudePermissionMode string   `json:"claudePermissionMode,omitempty"`
	CodexReasoningEffort string   `json:"codexReasoningEffort,omitempty"`
	CodexSandboxMode     string   `json:"codexSandboxMode,omitempty"`
	CodexApprovalPolicy  string   `json:"codexApprovalPolicy,omitempty"`
	CodexSpeed           string   `json:"codexSpeed,omitempty"`
	APIKey               string   `json:"apiKey,omitempty"`
	// OwnerUserID is set by the server from the caller on create and never
	// changed by an update; clients cannot supply it.
	OwnerUserID string `json:"-"`
}

// SetDeviceProfilesInput replaces the whole enabled set for one device.
type SetDeviceProfilesInput struct {
	DeviceID   string   `json:"deviceId"`
	ProfileIDs []string `json:"profileIds"`
}

// PromoteProfileInput lifts a daemon-discovered device profile into a server
// profile. The credential the device holds always moves with it: a promoted
// profile without a credential cannot authenticate anywhere, including on the
// device it came from, because a dispatched server definition never consults
// the local profiles file.
type PromoteProfileInput struct {
	DeviceID  string `json:"deviceId"`
	ProfileID string `json:"profileId"`
}

type AgentProjection struct {
	ID                 string `json:"id"`
	WorkspaceID        string `json:"workspaceId"`
	DeviceID           string `json:"deviceId"`
	DeviceLabel        string `json:"deviceLabel"`
	Provider           string `json:"provider"`
	ProfileID          string `json:"profileId,omitempty"`
	ProfileFingerprint string `json:"profileFingerprint,omitempty"`
	ProfileLabel       string `json:"profileLabel,omitempty"`
	ConnectionType     string `json:"connectionType,omitempty"`
	Status             string `json:"status"`
	AuthMode           string `json:"authMode"`
	SecretStored       string `json:"secretStored"`
	ConfigScope        string `json:"configScope"`
	ConfigLabel        string `json:"configLabel"`
	LastSeenLabel      string `json:"lastSeenLabel"`
	StatusDetail       string `json:"statusDetail,omitempty"`
}

type CreateAgentProfileInput struct {
	ID                   string            `json:"id,omitempty"`
	DeviceID             string            `json:"deviceId,omitempty"`
	WorkspaceID          string            `json:"workspaceId,omitempty"`
	Runtime              string            `json:"runtime"`
	Label                string            `json:"label"`
	ConfigScope          string            `json:"configScope"`
	ConnectionType       string            `json:"connectionType"`
	BaseURL              string            `json:"baseUrl,omitempty"`
	Model                string            `json:"model,omitempty"`
	Models               []string          `json:"models,omitempty"`
	PromptPrefix         string            `json:"promptPrefix,omitempty"`
	ClaudeEffort         string            `json:"claudeEffort,omitempty"`
	ClaudePermissionMode string            `json:"claudePermissionMode,omitempty"`
	CodexReasoningEffort string            `json:"codexReasoningEffort,omitempty"`
	CodexSandboxMode     string            `json:"codexSandboxMode,omitempty"`
	CodexApprovalPolicy  string            `json:"codexApprovalPolicy,omitempty"`
	CodexSpeed           string            `json:"codexSpeed,omitempty"`
	APIKey               string            `json:"apiKey,omitempty"`
	Command              string            `json:"command,omitempty"`
	Env                  map[string]string `json:"env,omitempty"`
}

type AgentModelOption struct {
	ID    string `json:"id"`
	Label string `json:"label,omitempty"`
}

type ListAgentModelsInput struct {
	Profile CreateAgentProfileInput `json:"profile"`
}
