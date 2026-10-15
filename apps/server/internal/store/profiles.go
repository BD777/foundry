package store

import (
	"context"
	"net"
	"net/url"
	"strings"
	"time"
)

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
	ContextWindows       map[string]int64   `json:"contextWindows,omitempty"`
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
	KeySource            string             `json:"keySource,omitempty"`
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
	ID             string   `json:"id"`
	Runtime        string   `json:"runtime"`
	Label          string   `json:"label"`
	AuthMode       string   `json:"authMode"`
	ConnectionType string   `json:"connectionType"`
	BaseURL        string   `json:"baseUrl,omitempty"`
	Model          string   `json:"model,omitempty"`
	Models         []string `json:"models,omitempty"`
	// ContextWindows is the person's own context window per model id, in
	// tokens. A model without one runs with the window its endpoint reports,
	// else the official model's, else 1M (decided by the worker).
	ContextWindows       map[string]int64 `json:"contextWindows,omitempty"`
	PromptPrefix         string           `json:"promptPrefix,omitempty"`
	ClaudeEffort         string           `json:"claudeEffort,omitempty"`
	ClaudePermissionMode string           `json:"claudePermissionMode,omitempty"`
	CodexReasoningEffort string           `json:"codexReasoningEffort,omitempty"`
	CodexSandboxMode     string           `json:"codexSandboxMode,omitempty"`
	CodexApprovalPolicy  string           `json:"codexApprovalPolicy,omitempty"`
	CodexSpeed           string           `json:"codexSpeed,omitempty"`
	// CodexTransport is set on every compatible Codex endpoint (auto,
	// websocket or https): its presence tells the worker this server learns
	// the transport. CodexTransportLearned is the current observation.
	CodexTransport        string                     `json:"codexTransport,omitempty"`
	CodexTransportLearned *CodexTransportObservation `json:"codexTransportLearned,omitempty"`
	HasCredential         bool                       `json:"hasCredential"`
	OwnerUserID           string                     `json:"ownerUserId,omitempty"`
	// PromotedFrom is set when the profile was promoted from a provider in a
	// device's own configuration.
	PromotedFrom   *ProfilePromotionSource `json:"promotedFrom,omitempty"`
	UpdatedAtLabel string                  `json:"updatedAtLabel"`
}

// Responses transports of a compatible Codex endpoint, and the person's
// choice between them (CodexTransportAuto learns it).
const (
	CodexTransportAuto      = "auto"
	CodexTransportWebSocket = "websocket"
	CodexTransportHTTPS     = "https"
)

// CodexTransportObservationTTL is how long an observation stands before a
// session tries the WebSocket again (protocol codexTransportObservationDays).
const CodexTransportObservationTTL = 7 * 24 * time.Hour

// CodexTransportObservation is what a Codex session showed about its
// endpoint's Responses WebSocket: it fell back to HTTPS (Detail is Codex's
// reason), or a turn completed with the WebSocket on and no fallback.
type CodexTransportObservation struct {
	Transport string `json:"transport"`
	Detail    string `json:"detail,omitempty"`
	LearnedAt string `json:"learnedAt"`
}

// CodexTransportReport is a session's observation, for the profile and base
// URL it ran (session event metadata codexTransport).
type CodexTransportReport struct {
	ProfileID string `json:"profileId"`
	BaseURL   string `json:"baseUrl"`
	Transport string `json:"transport"`
	Detail    string `json:"detail,omitempty"`
}

// CodexTransportStore keeps the observations per profile and base URL. A
// profile lists only the one for its current base URL within the TTL;
// saving or deleting the profile forgets them.
type CodexTransportStore interface {
	RecordCodexTransport(ctx context.Context, profileID string, baseURL string, observation CodexTransportObservation) error
}

// ProfilePromotionSource is the device provider a server profile was promoted
// from. Promoting the same provider again updates that profile.
type ProfilePromotionSource struct {
	DeviceID  string `json:"deviceId"`
	ProfileID string `json:"profileId"`
	// DeviceBound: the base URL is the device's own loopback address, which no
	// other device can reach, so the profile may run only on that device.
	DeviceBound bool `json:"deviceBound,omitempty"`
}

// ProfilePromotion records which server profile a device provider was
// promoted into.
type ProfilePromotion struct {
	ProfileID       string
	DeviceID        string
	SourceProfileID string
}

// ProfilePromotionStore remembers which server profile each promoted device
// provider became, so promoting it again updates that profile.
type ProfilePromotionStore interface {
	// ProfilePromotionFor names the server profile a device provider was
	// promoted into, or reports ErrNotFound.
	ProfilePromotionFor(ctx context.Context, deviceID string, sourceProfileID string) (string, error)
	SaveProfilePromotion(ctx context.Context, promotion ProfilePromotion) error
}

// LoopbackBaseURL reports a base URL whose host is the machine itself
// (localhost, 127.0.0.0/8, ::1): only the device that configured it reaches it.
func LoopbackBaseURL(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
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
	// CodexTransport: auto (also when empty), websocket or https; compatible
	// Codex endpoints only.
	CodexTransport string `json:"codexTransport,omitempty"`
	// ContextWindows replaces the stored per-model windows; nil keeps them.
	ContextWindows map[string]int64 `json:"contextWindows,omitempty"`
	APIKey         string           `json:"apiKey,omitempty"`
	// OwnerUserID is set by the server from the caller on create and never
	// changed by an update; clients cannot supply it.
	OwnerUserID string `json:"-"`
}

// SetDeviceProfilesInput replaces the whole enabled set for one device.
type SetDeviceProfilesInput struct {
	DeviceID   string   `json:"deviceId"`
	ProfileIDs []string `json:"profileIds"`
}

// PromoteProfileInput promotes an API provider from a device's own
// configuration into a server profile, or updates the profile it was promoted
// into before. CopyKey is the person's explicit confirmation that the key the
// provider's configuration names may be read on the device and sealed on the
// server; without it no key is copied.
type PromoteProfileInput struct {
	DeviceID  string `json:"deviceId"`
	ProfileID string `json:"profileId"`
	CopyKey   bool   `json:"copyKey,omitempty"`
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
	ContextWindows       map[string]int64  `json:"contextWindows"`
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
	// ContextWindow is the window the endpoint's own catalog reports.
	ContextWindow int64 `json:"contextWindow,omitempty"`
}

type ListAgentModelsInput struct {
	Profile CreateAgentProfileInput `json:"profile"`
}
