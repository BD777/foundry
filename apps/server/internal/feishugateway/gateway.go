// Package feishugateway is how sessions reach Feishu without any Feishu
// credential on their device.
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
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/integrations"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// PathPrefix is where the gateway's routes live on the server; a device's
// forwarder maps its own root here.
const PathPrefix = "/api/feishu-gw"

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
type Device struct {
	ID          string
	OwnerUserID string
}

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

	sessionLimit *limiter
	appLimit     *limiter
	tickets      eventTickets

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
	return &Gateway{
		store: st, accounts: accounts, sessions: sessions, service: service,
		AuditRetention: 30 * 24 * time.Hour,
		Now:            time.Now,
		Logf:           log.Printf,
		sessionLimit:   &limiter{rate: Rate{PerSecond: 20, Burst: 60}},
		appLimit:       &limiter{rate: Rate{PerSecond: 50, Burst: 150}},
		tenants:        map[string]*tenantToken{},
	}
}

// SetRates replaces the per-session and per-app limits.
func (g *Gateway) SetRates(session, app Rate) {
	g.sessionLimit = &limiter{rate: session}
	g.appLimit = &limiter{rate: app}
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

type authorized struct {
	grant   store.FeishuGatewayGrant
	caller  Caller
	app     store.ExternalProviderApp
	account store.ExternalAccount
}

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

func (g *Gateway) authorize(ctx context.Context, handle string, device Device) (authorized, error) {
	kind := handleKind(handle)
	if kind == "" {
		return authorized{}, errAccessEnded
	}
	grant, err := g.store.FindFeishuGatewayGrant(ctx, kind, hashHandle(handle))
	if errors.Is(err, store.ErrNotFound) {
		return authorized{}, errAccessEnded
	}
	if err != nil {
		return authorized{}, err
	}
	return g.authorizeGrant(ctx, grant, device)
}

func (g *Gateway) authorizeGrant(ctx context.Context, grant store.FeishuGatewayGrant, device Device) (authorized, error) {
	if device.ID == "" || grant.DeviceID != device.ID {
		return authorized{}, errAccessEnded
	}
	caller := Caller{SessionID: grant.SessionID, WorkspaceID: grant.WorkspaceID, DeviceID: grant.DeviceID, UserID: grant.UserID, AccountID: grant.AccountID, AppID: grant.AppID}
	account, app, err := g.check(ctx, caller, device.OwnerUserID)
	if errors.Is(err, errSessionEnded) {
		if deleteErr := g.store.DeleteFeishuGatewayGrant(ctx, grant.ID); deleteErr != nil {
			g.logf("feishu gateway: drop the grant of ended session %s: %v", grant.SessionID, deleteErr)
		}
		return authorized{}, errAccessEnded
	}
	if err != nil {
		return authorized{}, err
	}
	caller.ClientID = app.ClientID
	return authorized{grant: grant, caller: caller, app: app, account: account}, nil
}

var errSessionEnded = errors.New("session ended")

// check is the live part of authorization: the session active on the
// caller's device, the account usable by it.
func (g *Gateway) check(ctx context.Context, caller Caller, deviceOwner string) (store.ExternalAccount, store.ExternalProviderApp, error) {
	session, err := g.sessions.GetAgentSessionSummary(ctx, caller.SessionID)
	if errors.Is(err, store.ErrNotFound) {
		return store.ExternalAccount{}, store.ExternalProviderApp{}, errSessionEnded
	}
	if err != nil {
		return store.ExternalAccount{}, store.ExternalProviderApp{}, err
	}
	if !activeSession(session.Status) || session.DeviceID != caller.DeviceID || session.CreatedByUserID != caller.UserID {
		return store.ExternalAccount{}, store.ExternalProviderApp{}, errSessionEnded
	}
	account, err := g.accounts.GetExternalAccount(ctx, caller.AccountID)
	if err != nil {
		return store.ExternalAccount{}, store.ExternalProviderApp{}, errAccessEnded
	}
	if account.AppID != caller.AppID || !externalaccounts.Eligible(account, account.WorkspaceIDs, session.WorkspaceID, session.CreatedByUserID, deviceOwner) {
		return store.ExternalAccount{}, store.ExternalProviderApp{}, errAccessEnded
	}
	app, err := g.accounts.GetExternalProviderApp(ctx, account.AppID)
	if err != nil {
		return store.ExternalAccount{}, store.ExternalProviderApp{}, errAccessEnded
	}
	return account, app, nil
}

// Authorized re-checks a caller the gateway handed to EventSubscriptions:
// nil while its session is active and its account usable there.
func (g *Gateway) Authorized(ctx context.Context, caller Caller) error {
	_, _, err := g.check(ctx, caller, caller.UserID)
	if errors.Is(err, errSessionEnded) {
		return errAccessEnded
	}
	return err
}

func activeSession(status string) bool {
	return status == "queued" || status == "running" || status == "blocked"
}

// --- Serving -----------------------------------------------------------------

// Serve answers one request under PathPrefix from an authenticated device.
func (g *Gateway) Serve(w http.ResponseWriter, r *http.Request, device Device) {
	path := strings.TrimPrefix(r.URL.Path, PathPrefix)
	if path == "" {
		path = "/"
	}
	// Until a handle names the session, the call is the device owner's.
	line := &store.FeishuGatewayRequest{Method: r.Method, Path: pathTemplate(path), DeviceID: device.ID, UserID: device.OwnerUserID}
	started := g.Now()
	if r.Method == http.MethodGet && path == eventSocketPath {
		// The socket is hijacked: no counting writer in between.
		g.serveEventSocket(w, r, device, line)
		g.record(line, started)
		return
	}
	body := &countingBody{ReadCloser: r.Body}
	if r.Body != nil && r.Body != http.NoBody {
		r.Body = body
	}
	writer := &countingWriter{ResponseWriter: w}
	defer func() {
		line.BytesIn, line.BytesOut, line.Status = body.n, writer.n, writer.status
		g.record(line, started)
	}()
	switch {
	case r.Method == http.MethodPost && path == externalaccounts.FeishuTenantTokenPath:
		g.serveTenantToken(writer, r, device, line)
	case r.Method == http.MethodPost && path == eventEndpointPath:
		g.serveEventEndpoint(writer, r, device, line)
	case r.Method == http.MethodPost && path == userRefreshPath:
		g.serveUserRefresh(writer, r, device, line)
	case strings.HasPrefix(path, "/open-apis/"):
		g.forward(writer, r, device, path, line)
	default:
		line.Outcome = "refused"
		writeFeishu(writer, http.StatusNotFound, 404, "Foundry's Feishu gateway does not serve "+line.Path+": sessions cannot log in, register apps or revoke logins through Foundry")
	}
}

func (g *Gateway) record(line *store.FeishuGatewayRequest, started time.Time) {
	line.At = started.UTC().Format(time.RFC3339Nano)
	line.DurationMS = g.Now().Sub(started).Milliseconds()
	if line.Outcome == "" {
		line.Outcome = "refused"
	}
	if err := g.store.AppendFeishuGatewayRequest(context.Background(), *line); err != nil {
		g.logf("feishu gateway: audit %s %s: %v", line.Method, line.Path, err)
	}
}

func (line *authorized) fill(request *store.FeishuGatewayRequest) {
	request.UserID, request.SessionID, request.WorkspaceID = line.caller.UserID, line.caller.SessionID, line.caller.WorkspaceID
	request.AccountID, request.AppID = line.caller.AccountID, line.caller.AppID
}

// serveTenantToken answers the SDK's tenant token call
// ({app_id, app_secret}) with the session's tenant stand-in.
func (g *Gateway) serveTenantToken(w http.ResponseWriter, r *http.Request, device Device, line *store.FeishuGatewayRequest) {
	var input struct {
		AppID     string `json:"app_id"`
		AppSecret string `json:"app_secret"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, maxTokenBody)).Decode(&input); err != nil {
		writeFeishu(w, http.StatusBadRequest, 10003, "Foundry gateway: unreadable tenant token request")
		return
	}
	access, err := g.authorize(r.Context(), strings.TrimSpace(input.AppSecret), device)
	if err == nil && handleKind(input.AppSecret) != store.FeishuHandleApp {
		err = errAccessEnded
	}
	if err != nil {
		g.refuse(w, err, 10014, line)
		return
	}
	access.fill(line)
	if input.AppID != access.caller.ClientID {
		writeFeishu(w, http.StatusOK, 10003, "Foundry gateway: app_id does not match this session's Feishu app")
		return
	}
	tenant, _ := derivedHandle(strings.TrimSpace(input.AppSecret), tenantHandlePrefix)
	line.Outcome = "local"
	writeJSON(w, http.StatusOK, map[string]any{"code": 0, "msg": "ok", "tenant_access_token": tenant, "expire": tenantTokenExpire})
}

// serveUserRefresh answers feishu-cli's user token refresh (OAuth form:
// grant_type=refresh_token, refresh_token, client_id, client_secret) with
// the session's stand-ins again, never a real token. The real login is
// refreshed by the server when a call needs it; the device's refresh only
// keeps feishu-cli's token.json current and is refused once access ends.
func (g *Gateway) serveUserRefresh(w http.ResponseWriter, r *http.Request, device Device, line *store.FeishuGatewayRequest) {
	oauthError := func(status int, code, description string) {
		line.Outcome = "refused"
		writeJSON(w, status, map[string]any{"error": code, "error_description": "Foundry gateway: " + description})
	}
	if err := r.ParseForm(); err != nil {
		oauthError(http.StatusBadRequest, "invalid_request", "unreadable token request")
		return
	}
	appHandle := strings.TrimSpace(r.PostForm.Get("client_secret"))
	if r.PostForm.Get("grant_type") != "refresh_token" || handleKind(appHandle) != store.FeishuHandleApp {
		oauthError(http.StatusBadRequest, "invalid_grant", "sessions can only refresh the login Foundry set up for them; they cannot log in through Foundry")
		return
	}
	access, err := g.authorize(r.Context(), appHandle, device)
	if errors.Is(err, errAccessEnded) {
		oauthError(http.StatusBadRequest, "invalid_grant", err.Error())
		return
	}
	if err != nil {
		g.logf("feishu gateway: authorize: %v", err)
		oauthError(http.StatusInternalServerError, "server_error", "could not check this session's access")
		return
	}
	access.fill(line)
	line.Identity = "user"
	refresh, _ := derivedHandle(appHandle, refreshHandlePrefix)
	presented := strings.TrimSpace(r.PostForm.Get("refresh_token"))
	if r.PostForm.Get("client_id") != access.caller.ClientID || !hmac.Equal([]byte(presented), []byte(refresh)) {
		oauthError(http.StatusBadRequest, "invalid_grant", "the refresh token or client_id is not this session's; use the Feishu profile Foundry set up (FEISHU_PROFILE)")
		return
	}
	user, _ := derivedHandle(appHandle, userHandlePrefix)
	line.Outcome = "local"
	writeJSON(w, http.StatusOK, map[string]any{
		"code": 0, "access_token": user, "refresh_token": refresh, "token_type": "Bearer", "expires_in": userTokenExpire,
	})
}

// serveEventEndpoint answers the SDK's long connection discovery
// ({AppID, AppSecret}) through EventSubscriptions.
func (g *Gateway) serveEventEndpoint(w http.ResponseWriter, r *http.Request, device Device, line *store.FeishuGatewayRequest) {
	var input struct {
		AppID     string `json:"AppID"`
		AppSecret string `json:"AppSecret"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, maxTokenBody)).Decode(&input); err != nil {
		writeFeishu(w, http.StatusBadRequest, 1, "Foundry gateway: unreadable event endpoint request")
		return
	}
	access, err := g.authorize(r.Context(), strings.TrimSpace(input.AppSecret), device)
	if err == nil && (handleKind(input.AppSecret) != store.FeishuHandleApp || input.AppID != access.caller.ClientID) {
		err = errAccessEnded
	}
	if err != nil {
		g.refuse(w, err, 514, line)
		return
	}
	access.fill(line)
	if g.Events == nil {
		line.Outcome = "unavailable"
		writeFeishu(w, http.StatusServiceUnavailable, 503, "Foundry gateway: Feishu events are not available through this Foundry server yet")
		return
	}
	host := strings.TrimSpace(r.Header.Get(ForwarderHostHeader))
	if !loopbackHost(host) {
		writeFeishu(w, http.StatusBadRequest, 1, "Foundry gateway: event connections need the worker's loopback forwarder")
		return
	}
	ticket := g.tickets.issue(access.grant, g.Now())
	connectURL := "ws://" + host + eventSocketPath + "?foundry_ticket=" + url.QueryEscape(ticket)
	line.Outcome = "local"
	g.Events.ServeEndpoint(w, r, access.caller, connectURL)
}

func (g *Gateway) serveEventSocket(w http.ResponseWriter, r *http.Request, device Device, line *store.FeishuGatewayRequest) {
	grant, ok := g.tickets.redeem(r.URL.Query().Get("foundry_ticket"), g.Now())
	if !ok {
		line.Status = http.StatusUnauthorized
		writeFeishu(w, http.StatusUnauthorized, 1, "Foundry gateway: the event connection ticket is unknown, spent or expired; reconnect")
		return
	}
	if current, err := g.store.FindFeishuGatewayGrant(r.Context(), store.FeishuHandleApp, grant.AppHash); err != nil || current.ID != grant.ID {
		line.Status = http.StatusUnauthorized
		writeFeishu(w, http.StatusUnauthorized, 1, errAccessEnded.Error())
		return
	}
	access, err := g.authorizeGrant(r.Context(), grant, device)
	if err != nil {
		line.Status = http.StatusUnauthorized
		g.refuse(w, err, 1, line)
		return
	}
	access.fill(line)
	if g.Events == nil {
		line.Status, line.Outcome = http.StatusServiceUnavailable, "unavailable"
		writeFeishu(w, http.StatusServiceUnavailable, 503, "Foundry gateway: Feishu events are not available through this Foundry server yet")
		return
	}
	line.Status, line.Outcome = http.StatusSwitchingProtocols, "local"
	g.Events.ServeConnection(w, r, access.caller)
}

// refuse answers a failed authorization the way Feishu answers a bad
// credential, with code.
func (g *Gateway) refuse(w http.ResponseWriter, err error, code int, line *store.FeishuGatewayRequest) {
	line.Outcome = "refused"
	if errors.Is(err, errAccessEnded) {
		writeFeishu(w, http.StatusUnauthorized, code, "Foundry gateway: "+err.Error())
		return
	}
	g.logf("feishu gateway: authorize: %v", err)
	writeFeishu(w, http.StatusInternalServerError, code, "Foundry gateway: could not check this session's access")
}

// forward swaps the stand-in for the real token and streams the call.
func (g *Gateway) forward(w http.ResponseWriter, r *http.Request, device Device, path string, line *store.FeishuGatewayRequest) {
	handle := bearer(r)
	kind := handleKind(handle)
	if kind != store.FeishuHandleUser && kind != store.FeishuHandleTenant {
		line.Outcome = "refused"
		writeFeishu(w, http.StatusUnauthorized, 99991661, "Foundry gateway: the call carries no token of this session; use the Feishu profile Foundry set up (FEISHU_PROFILE)")
		return
	}
	invalidCode := 99991668
	line.Identity = "user"
	if kind == store.FeishuHandleTenant {
		invalidCode, line.Identity = 99991663, "bot"
	}
	access, err := g.authorize(r.Context(), handle, device)
	if err != nil {
		g.refuse(w, err, invalidCode, line)
		return
	}
	access.fill(line)
	if reason := blocked(r.Method, path); reason != "" {
		line.Outcome = "blocked"
		writeFeishu(w, http.StatusForbidden, 99991672, "Foundry gateway: "+r.Method+" "+line.Path+" is not available to sessions ("+reason+")")
		return
	}
	if err := g.Integrations.Err(); err != nil {
		line.Outcome = "unavailable"
		writeFeishu(w, http.StatusServiceUnavailable, 1, "Foundry gateway: "+err.Error())
		return
	}
	now := g.Now()
	allowed, wait := g.sessionLimit.take(access.caller.SessionID, now)
	if allowed {
		allowed, wait = g.appLimit.take(access.caller.AppID, now)
	}
	if !allowed {
		line.Outcome = "rate_limited"
		seconds := int(wait/time.Second) + 1
		w.Header().Set("x-ogw-ratelimit-reset", strconv.Itoa(seconds))
		w.Header().Set("Retry-After", strconv.Itoa(seconds))
		writeFeishu(w, http.StatusTooManyRequests, 99991400, "Foundry gateway: too many Feishu calls from this session; slow down")
		return
	}
	var token string
	if kind == store.FeishuHandleUser {
		minted, mintErr := g.service.AccessToken(r.Context(), access.caller.AccountID, externalaccounts.Use{SessionID: access.caller.SessionID, DeviceID: device.ID, By: "session"})
		token, err = minted.AccessToken, mintErr
	} else {
		token, err = g.tenantToken(r.Context(), access.app)
	}
	if err != nil {
		g.tokenFailed(w, err, invalidCode, line)
		return
	}
	target, err := url.Parse(upstreamBase(access.app.BaseURL))
	if err != nil {
		line.Outcome = "upstream_error"
		writeFeishu(w, http.StatusBadGateway, 1, "Foundry gateway: the app's base URL is invalid")
		return
	}
	line.Outcome = "forwarded"
	proxy := &httputil.ReverseProxy{
		Rewrite: func(out *httputil.ProxyRequest) {
			out.Out.URL.Scheme, out.Out.URL.Host = target.Scheme, target.Host
			out.Out.URL.Path, out.Out.URL.RawPath = strings.TrimRight(target.Path, "/")+path, ""
			out.Out.URL.RawQuery = r.URL.RawQuery
			out.Out.Host = ""
			for _, header := range []string{"X-Foundry-Device-Credential", ForwarderHostHeader, "Cookie", "Authorization"} {
				out.Out.Header.Del(header)
			}
			out.Out.Header.Set("Authorization", "Bearer "+token)
		},
		FlushInterval: -1,
		Transport:     g.Transport,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			line.Outcome = "upstream_error"
			g.logf("feishu gateway: forward %s %s: %v", r.Method, line.Path, err)
			writeFeishu(w, http.StatusBadGateway, 1, "Foundry gateway: Feishu could not be reached")
		},
	}
	proxy.ServeHTTP(w, r)
}

func (g *Gateway) tokenFailed(w http.ResponseWriter, err error, invalidCode int, line *store.FeishuGatewayRequest) {
	line.Outcome = "upstream_error"
	switch {
	case errors.Is(err, integrations.ErrOff):
		line.Outcome = "unavailable"
		writeFeishu(w, http.StatusServiceUnavailable, 1, "Foundry gateway: "+err.Error())
	case errors.Is(err, externalaccounts.ErrAccountUnusable):
		line.Outcome = "refused"
		writeFeishu(w, http.StatusUnauthorized, invalidCode, "Foundry gateway: the Feishu account needs to be re-authorized in Foundry (Connectors → Feishu)")
	default:
		g.logf("feishu gateway: token for %s: %v", line.AccountID, err)
		writeFeishu(w, http.StatusBadGateway, invalidCode, "Foundry gateway: could not get a Feishu token for this call: "+err.Error())
	}
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

type countingBody struct {
	io.ReadCloser
	n int64
}

func (b *countingBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.n += int64(n)
	return n, err
}

type countingWriter struct {
	http.ResponseWriter
	status int
	n      int64
}

func (c *countingWriter) WriteHeader(status int) {
	if c.status == 0 && status >= 200 {
		c.status = status
	}
	c.ResponseWriter.WriteHeader(status)
}

func (c *countingWriter) Write(p []byte) (int, error) {
	if c.status == 0 {
		c.status = http.StatusOK
	}
	n, err := c.ResponseWriter.Write(p)
	c.n += int64(n)
	return n, err
}

func (c *countingWriter) Flush() {
	if flusher, ok := c.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (c *countingWriter) Unwrap() http.ResponseWriter { return c.ResponseWriter }
