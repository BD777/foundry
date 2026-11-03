package store

import (
	"context"
	"net"
	"net/url"
	"strings"
	"time"
)

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

// CodexTransportStore keeps the observations per profile and base URL. A
// profile lists only the one for its current base URL within the TTL;
// saving or deleting the profile forgets them.
type CodexTransportStore interface {
	RecordCodexTransport(ctx context.Context, profileID string, baseURL string, observation CodexTransportObservation) error
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

type ListAgentModelsInput struct {
	Profile CreateAgentProfileInput `json:"profile"`
}
