// Package feishugateway is how sessions reach Feishu without any Feishu
// credential on their device. It is the Feishu connector of the common
// gateway pipeline (internal/gateway): the pipeline authenticates, rechecks,
// compares, limits and audits; this package says what a Feishu request
// touches (provider.go), how a refusal looks in Feishu's error format, how
// a call is streamed to Feishu, and which calls it answers itself (local.go).
//
// feishu-cli on the device is configured, through its documented profile
// (config.yaml app_id / app_secret / base_url, token.json), with the app id,
// a stand-in for the app secret and a stand-in for the user access token,
// and a base URL on the worker's loopback forwarder. The forwarder adds the
// device's credential and sends everything here, under PathPrefix. The
// gateway:
//
//   - authenticates each request: the device credential (httpapi), a live
//     grant for the handle, the session still active on that device, the
//     account still usable and bound to the session's workspace. Revocation
//     is therefore immediate: a session that ends, an account stopped or
//     disconnected, a binding removed, and the next request is refused;
//   - answers feishu-cli's tenant token call and its user token refresh
//     itself, with stand-ins: the server alone refreshes the real login;
//   - swaps the stand-ins for the real tokens (the user's from the
//     externalaccounts service, the single refresher; the app's own fetched
//     with the sealed secret and cached) and streams the call to Feishu;
//   - refuses a short blocklist (policy.go), rate-limits per session and
//     per app, and writes one audit line per request, without bodies;
//   - hands feishu-cli's event connection to EventSubscriptions.
//
// Handles: "fsg_" (app secret stand-in) is 32 random bytes; "fsu_" (user
// token), "fsr_" (user refresh token) and "fst_" (tenant token) are derived
// from it, so the gateway can answer the tenant token and refresh calls
// from the app handle alone. Only their SHA-256 hashes are stored.
package feishugateway

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
	"github.com/foundry-dev/foundry/apps/server/internal/integrations"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// PathPrefix is where the gateway's routes live on the server; a device's
// forwarder maps its own root here.
const PathPrefix = "/api/feishu-gw"

// ConnectorPathPrefix is the same gateway under the connectors' common
// route shape (/api/connectors/<kind>/gateway); PathPrefix, the route the
// materials of sessions hand out, is its alias.
const ConnectorPathPrefix = "/api/connectors/feishu/gateway"

// ForwarderHostHeader is the host:port of the loopback forwarder the
// request came through, so event connect URLs point back at it.
const ForwarderHostHeader = "X-Foundry-Forwarder-Host"

const (
	appHandlePrefix     = "fsg_"
	userHandlePrefix    = "fsu_"
	refreshHandlePrefix = "fsr_"
	tenantHandlePrefix  = "fst_"

	eventEndpointPath = "/callback/ws/endpoint"
	userRefreshPath   = "/open-apis/authen/v2/oauth/token"

	// tenantTokenExpire is the lifetime feishu-cli is told its tenant
	// stand-in has; it fetches another after, which costs nothing.
	tenantTokenExpire = 7200
	// userTokenExpire is the lifetime feishu-cli is told a refreshed user
	// stand-in has; it refreshes again after, which costs nothing.
	userTokenExpire = 7200
	maxTokenBody    = 64 << 10
)

// Sessions reads the session a grant belongs to.
type Sessions interface {
	GetAgentSessionSummary(ctx context.Context, id string) (store.AgentSession, error)
}

// Device is the authenticated device a request came from.
type Device = gateway.Device

// Gateway serves PathPrefix. Set Events before serving.
type Gateway struct {
	store    store.FeishuGatewayStore
	accounts store.ExternalAccountStore
	sessions Sessions
	service  *externalaccounts.Service

	// Integrations off: nothing is forwarded to Feishu. Nil is on.
	Integrations *integrations.Switch
	// Events serves feishu-cli's event connection; nil answers 503.
	Events EventSubscriptions
	// Transport carries forwarded calls; nil is http.DefaultTransport.
	Transport http.RoundTripper
	// AuditRetention is how long audit lines are kept.
	AuditRetention time.Duration
	Now            func() time.Time
	Logf           func(format string, args ...any)

	pipeline *gateway.Pipeline
	tickets  eventTickets

	tenantMu sync.Mutex
	tenants  map[string]*tenantToken
}

type tenantToken struct {
	mu      sync.Mutex
	token   string
	expires time.Time
}

// New builds a gateway with the default limits: per session 20 calls a
// second (bursts of 60), per app 50 (bursts of 150). Feishu's own limits
// still apply behind them and its 429s pass through unchanged.
func New(st store.FeishuGatewayStore, accounts store.ExternalAccountStore, sessions Sessions, service *externalaccounts.Service) *Gateway {
	g := &Gateway{
		store: st, accounts: accounts, sessions: sessions, service: service,
		AuditRetention: 30 * 24 * time.Hour,
		Now:            time.Now,
		Logf:           log.Printf,
		tenants:        map[string]*tenantToken{},
	}
	g.pipeline = &gateway.Pipeline{
		Scheme: gateway.Scheme{
			Provider: "feishu", Kind: handleKind, Hash: hashHandle,
			Bearer: []string{store.FeishuHandleUser, store.FeishuHandleTenant},
		},
		Provider: g, Sessions: sessions, Grants: st, Accounts: accounts, Audit: auditLines{g},
		// Every Feishu call is "full": the person decided pass-through
		// within the granted scopes (2026-10-12), so there is one level.
		Levels:      []store.ExternalAccessLevel{{Name: levelFull}},
		Unavailable: func() error { return g.Integrations.Err() },
		Now:         func() time.Time { return g.Now() },
		Logf:        g.logf,
	}
	g.SetRates(Rate{PerSecond: 20, Burst: 60}, Rate{PerSecond: 50, Burst: 150})
	return g
}

// SetRates replaces the per-session and per-app limits.
func (g *Gateway) SetRates(session, app Rate) {
	sessionLimit, appLimit := &limiter{rate: session}, &limiter{rate: app}
	g.pipeline.Limits = []gateway.Limit{
		{Key: func(l *gateway.Lease) string { return l.Grant.SessionID }, Take: sessionLimit.take},
		{Key: func(l *gateway.Lease) string { return l.Grant.AppID }, Take: appLimit.take},
	}
}

// Serve answers one request under PathPrefix from an authenticated device.
func (g *Gateway) Serve(w http.ResponseWriter, r *http.Request, device Device) {
	g.pipeline.Serve(w, r, device)
}

// --- Handles -------------------------------------------------------------------

func hashHandle(handle string) string {
	sum := sha256.Sum256([]byte(handle))
	return hex.EncodeToString(sum[:])
}

// derivedHandle is the user or tenant handle that belongs to an app handle.
func derivedHandle(appHandle, prefix string) (string, bool) {
	seed, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(appHandle, appHandlePrefix))
	if err != nil || !strings.HasPrefix(appHandle, appHandlePrefix) || len(seed) != 32 {
		return "", false
	}
	mac := hmac.New(sha256.New, seed)
	mac.Write([]byte(prefix))
	return prefix + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), true
}

// IssueHandles creates a session's grant for one account
// (externalaccounts.HandleIssuer).
func (g *Gateway) IssueHandles(ctx context.Context, request externalaccounts.HandleRequest) (store.ExternalAccountGateway, error) {
	if request.Account.Provider != "feishu" {
		return store.ExternalAccountGateway{}, errAccessEnded
	}
	seed := make([]byte, 32)
	if _, err := rand.Read(seed); err != nil {
		return store.ExternalAccountGateway{}, err
	}
	appHandle := appHandlePrefix + base64.RawURLEncoding.EncodeToString(seed)
	userHandle, _ := derivedHandle(appHandle, userHandlePrefix)
	refreshHandle, _ := derivedHandle(appHandle, refreshHandlePrefix)
	tenantHandle, _ := derivedHandle(appHandle, tenantHandlePrefix)
	if err := g.store.CreateFeishuGatewayGrant(ctx, store.FeishuGatewayGrant{
		SessionID: request.SessionID, AccountID: request.Account.ID, AppID: request.App.ID, DeviceID: request.DeviceID,
		WorkspaceID: request.WorkspaceID, UserID: request.UserID,
		AppHash: hashHandle(appHandle), UserHash: hashHandle(userHandle), TenantHash: hashHandle(tenantHandle),
	}); err != nil {
		return store.ExternalAccountGateway{}, err
	}
	return store.ExternalAccountGateway{Path: PathPrefix, AppHandle: appHandle, UserHandle: userHandle, RefreshHandle: refreshHandle}, nil
}

// --- Authorization -----------------------------------------------------------

// errAccessEnded: the handle names no live access (unknown, or the session
// ended, the account was stopped, disconnected or unbound).
var errAccessEnded = errors.New("this session's Feishu access through Foundry has ended (the session finished, or the account was stopped, removed or unbound); start a new session, or ask the person to check Connectors → Feishu in Foundry")

func handleKind(handle string) string {
	switch {
	case strings.HasPrefix(handle, appHandlePrefix):
		return store.FeishuHandleApp
	case strings.HasPrefix(handle, userHandlePrefix):
		return store.FeishuHandleUser
	case strings.HasPrefix(handle, tenantHandlePrefix):
		return store.FeishuHandleTenant
	}
	return ""
}

// callerOf is the Caller a lease stands for.
func callerOf(lease *gateway.Lease) Caller {
	grant := lease.Grant
	return Caller{SessionID: grant.SessionID, WorkspaceID: grant.WorkspaceID, DeviceID: grant.DeviceID, UserID: grant.UserID, AccountID: grant.AccountID, AppID: grant.AppID, ClientID: lease.App.ClientID}
}

// Authorized re-checks a caller the gateway handed to EventSubscriptions:
// nil while its session is active and its account usable there.
func (g *Gateway) Authorized(ctx context.Context, caller Caller) error {
	_, err := g.pipeline.Live(ctx, gateway.Subject{SessionID: caller.SessionID, WorkspaceID: caller.WorkspaceID, DeviceID: caller.DeviceID, UserID: caller.UserID, AccountID: caller.AccountID, AppID: caller.AppID}, caller.UserID)
	if errors.Is(err, gateway.ErrSessionEnded) || errors.Is(err, gateway.ErrAccessEnded) {
		return errAccessEnded
	}
	return err
}

// tenantToken is the app's own token, fetched with the sealed secret and
// reused until five minutes before it expires; one fetch per app at a time.
func (g *Gateway) tenantToken(ctx context.Context, app store.ExternalProviderApp) (string, error) {
	g.tenantMu.Lock()
	entry, ok := g.tenants[app.ID]
	if !ok {
		entry = &tenantToken{}
		g.tenants[app.ID] = entry
	}
	g.tenantMu.Unlock()
	entry.mu.Lock()
	defer entry.mu.Unlock()
	now := g.Now()
	if entry.token != "" && entry.expires.Sub(now) > 5*time.Minute {
		return entry.token, nil
	}
	token, lifetime, err := g.service.TenantAccessToken(ctx, app)
	if err != nil {
		return "", err
	}
	entry.token, entry.expires = token, now.Add(lifetime)
	return token, nil
}

// ForgetApp drops the app's cached token (its secret was replaced).
func (g *Gateway) ForgetApp(appID string) {
	g.tenantMu.Lock()
	defer g.tenantMu.Unlock()
	delete(g.tenants, appID)
}

// Run prunes, hourly until ctx ends, the grants of ended sessions and the
// audit lines older than AuditRetention.
func (g *Gateway) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		g.Prune(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// Prune removes ended sessions' grants and old audit lines.
func (g *Gateway) Prune(ctx context.Context) {
	if _, err := g.store.PruneFeishuGatewayGrants(ctx); err != nil {
		g.logf("feishu gateway: %v", err)
	}
	if _, err := g.store.PruneFeishuGatewayRequests(ctx, g.Now().Add(-g.AuditRetention)); err != nil {
		g.logf("feishu gateway: %v", err)
	}
}

func (g *Gateway) logf(format string, args ...any) {
	if g.Logf != nil {
		g.Logf(format, args...)
	}
}

func upstreamBase(baseURL string) string {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if base == "" {
		return externalaccounts.FeishuDefaultBaseURL
	}
	return base
}

func bearer(r *http.Request) string {
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(header) > 7 && strings.EqualFold(header[:7], "Bearer ") {
		return strings.TrimSpace(header[7:])
	}
	return ""
}

func loopbackHost(hostport string) bool {
	host, port, err := net.SplitHostPort(hostport)
	if err != nil || port == "" {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

// writeFeishu answers in Feishu's error shape, so feishu-cli shows msg.
func writeFeishu(w http.ResponseWriter, status, code int, message string) {
	writeJSON(w, status, map[string]any{"code": code, "msg": message})
}
