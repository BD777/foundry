package store

import (
	"context"
	"time"
)

// The Feishu gateway (internal/feishugateway) is how sessions reach Feishu
// without a credential on their device: feishu-cli on the device holds the
// app id and stand-in handles; the server swaps them for the real tokens.

// DaemonCapabilityFeishuGateway: the worker runs the loopback forwarder
// and writes gateway handles, never a secret, into feishu-cli profiles.
// Workers without it get no Feishu account at all.
const DaemonCapabilityFeishuGateway = "feishu_gateway"

// FeishuGatewayGrant is one session's stand-in credentials for one account.
// Only the handles' hashes are kept; a grant is usable while its session is
// active on DeviceID and the account may still be used there.
type FeishuGatewayGrant struct {
	ID        string
	SessionID string
	AccountID string
	// AppID is the external provider app (xapp_…) the account belongs to.
	AppID       string
	DeviceID    string
	WorkspaceID string
	// UserID is who started the session (the account owner).
	UserID string
	// AppHash stands in for the app secret, UserHash for the user access
	// token, TenantHash for the tenant (bot) access token.
	AppHash    string
	UserHash   string
	TenantHash string
	CreatedAt  string
}

// Feishu gateway handle kinds, as FindFeishuGatewayGrant looks them up.
const (
	FeishuHandleApp    = "app"
	FeishuHandleUser   = "user"
	FeishuHandleTenant = "tenant"
)

// FeishuGatewayRequest is one audit line of the gateway: who called what,
// and how it ended. It never holds a body, a query string or a token.
type FeishuGatewayRequest struct {
	ID          int64  `json:"id"`
	At          string `json:"at"`
	UserID      string `json:"userId,omitempty"`
	SessionID   string `json:"sessionId,omitempty"`
	DeviceID    string `json:"deviceId,omitempty"`
	WorkspaceID string `json:"workspaceId,omitempty"`
	AccountID   string `json:"accountId,omitempty"`
	AppID       string `json:"appId,omitempty"`
	// Identity is what the call acted as: "user", "bot", or "" when the
	// gateway answered without acting (token endpoints, refusals).
	Identity string `json:"identity,omitempty"`
	Method   string `json:"method"`
	// Path is the request path with ids replaced by ":id".
	Path       string `json:"path"`
	Status     int    `json:"status"`
	BytesIn    int64  `json:"bytesIn"`
	BytesOut   int64  `json:"bytesOut"`
	DurationMS int64  `json:"durationMs"`
	// Outcome: forwarded, local, blocked, refused, rate_limited,
	// unavailable, upstream_error.
	Outcome string `json:"outcome"`
}

// FeishuGatewayRequestFilter narrows the audit read; empty fields match all.
type FeishuGatewayRequestFilter struct {
	UserID    string
	SessionID string
	AccountID string
	// BeforeID pages backwards: only lines with a smaller id.
	BeforeID int64
	Limit    int
}

// FeishuGatewayStore keeps the gateway's grants and audit lines.
type FeishuGatewayStore interface {
	CreateFeishuGatewayGrant(ctx context.Context, grant FeishuGatewayGrant) error
	// FindFeishuGatewayGrant finds the grant holding hash as its kind of
	// handle; ErrNotFound when none does.
	FindFeishuGatewayGrant(ctx context.Context, kind, hash string) (FeishuGatewayGrant, error)
	DeleteFeishuGatewayGrant(ctx context.Context, id string) error
	// PruneFeishuGatewayGrants removes the grants of sessions that are no
	// longer active (queued, running or blocked).
	PruneFeishuGatewayGrants(ctx context.Context) (int, error)

	AppendFeishuGatewayRequest(ctx context.Context, request FeishuGatewayRequest) error
	// ListFeishuGatewayRequests lists audit lines, newest first.
	ListFeishuGatewayRequests(ctx context.Context, filter FeishuGatewayRequestFilter) ([]FeishuGatewayRequest, error)
	PruneFeishuGatewayRequests(ctx context.Context, before time.Time) (int, error)

	// FeishuAppsToRotate lists the Feishu provider apps whose secret was
	// handed to devices before the gateway existed, by app id with the
	// time that was noticed. ClearFeishuAppRotation drops an app from it
	// (its secret was replaced, or the app removed).
	FeishuAppsToRotate(ctx context.Context) (map[string]string, error)
	ClearFeishuAppRotation(ctx context.Context, appID string) error
}
