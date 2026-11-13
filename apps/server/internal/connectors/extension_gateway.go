package connectors

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	extensionHandlePrefix   = "fdyext_user_"
	ExtensionHandleLifetime = 30 * time.Minute
	extensionGatewayRead    = "read"
	extensionGatewayWrite   = "write"
	maxExtensionRequestBody = 8 << 20
)

var (
	ErrExtensionAccess        = errors.New("this session has no current grant for the selected connector extension instance")
	ErrExtensionHandleExpired = errors.New("connector extension session handle expired; refresh the session handle")
)

func ExtensionGatewayPath(kind string) string {
	return "/api/connectors/extensions/" + url.PathEscape(kind) + "/gateway"
}

func ExtensionSessionHandlePath(kind string) string {
	return "/api/connectors/extensions/" + url.PathEscape(kind) + "/session-handle"
}

type ExtensionGatewayStore interface {
	store.ExternalAccountStore
	store.FeishuGatewayStore
	store.DeviceConnectorStore
	externalaccounts.ConnectorAccessStore
	GetAgentSessionSummary(context.Context, string) (store.AgentSession, error)
	DeviceOwner(context.Context, string) (string, error)
	DeviceRemoved(context.Context, string) (bool, error)
}

type ExtensionGateway struct {
	store       ExtensionGatewayStore
	accounts    *externalaccounts.Service
	descriptors func(context.Context, string, string) (store.ConnectorDescriptor, error)
	Now         func() time.Time
	permission  permission.Store
	confirm     gateway.Confirmer
}

type extensionCall struct {
	Method string
	Path   string
	Query  url.Values
	Domain string
	Route  string
	Access string
}

type extensionAuditDetail struct {
	Kind        string `json:"kind"`
	WorkspaceID string `json:"workspaceId"`
	Method      string `json:"method"`
	Route       string `json:"route"`
	Access      string `json:"access,omitempty"`
	Write       bool   `json:"write,omitempty"`
	Domain      string `json:"domain,omitempty"`
	Status      int    `json:"status,omitempty"`
	Outcome     string `json:"outcome"`
	Error       string `json:"error,omitempty"`
}

var extensionSessionRate = gateway.Rate{PerSecond: 20, Burst: 60}

func NewExtensionGateway(st ExtensionGatewayStore, accounts *externalaccounts.Service, descriptors func(context.Context, string, string) (store.ConnectorDescriptor, error)) *ExtensionGateway {
	if st == nil {
		panic("NewExtensionGateway requires a store that resolves connector access")
	}
	return &ExtensionGateway{store: st, accounts: accounts, descriptors: descriptors, Now: time.Now}
}

func (g *ExtensionGateway) pipeline(kind string) *gateway.Pipeline {
	provider := &extensionGatewayProvider{gateway: g, kind: kind}
	return &gateway.Pipeline{
		Scheme: gateway.Scheme{
			Provider: kind, Kind: extensionHandleKind, Hash: extensionHandleHash,
			Bearer: []string{store.FeishuHandleUser}, Lifetime: ExtensionHandleLifetime,
		},
		Provider: provider, Sessions: g.store, Grants: g.store, Accounts: g.store,
		Access: g.store, Audit: extensionAudit{gateway: g},
		Levels: []store.ExternalAccessLevel{
			{Name: extensionGatewayRead},
			{Name: extensionGatewayWrite},
		},
		Limits:      []gateway.Limit{extensionSessionRate.PerKey(func(l *gateway.Lease) string { return l.Grant.SessionID })},
		Unavailable: func() error { return g.accounts.Integrations.Err() },
		Permission:  g.permission,
		Confirm:     g.confirm,
		Now:         func() time.Time { return g.Now() },
		Logf:        log.Printf,
	}
}

func (g *ExtensionGateway) Serve(w http.ResponseWriter, r *http.Request, device gateway.Device, kind string) {
	g.pipeline(kind).Serve(w, r, device)
}

func (g *ExtensionGateway) UsePermission(st permission.Store, confirm gateway.Confirmer) {
	g.permission = st
	g.confirm = confirm
}

func extensionHandleKind(handle string) string {
	if strings.HasPrefix(handle, extensionHandlePrefix) {
		return store.FeishuHandleUser
	}
	return ""
}

func extensionHandleHash(handle string) string {
	sum := sha256.Sum256([]byte(handle))
	return hex.EncodeToString(sum[:])
}

func (g *ExtensionGateway) sessionAccount(ctx context.Context, sessionID, deviceID, owner, accountID, kind string) (store.AgentSession, store.ExternalAccount, error) {
	session, err := g.store.GetAgentSessionSummary(ctx, sessionID)
	if err != nil || session.DeviceID != deviceID || session.CreatedByUserID != owner || gateway.SessionLive(session) != nil {
		return store.AgentSession{}, store.ExternalAccount{}, ErrExtensionAccess
	}
	if !takesConnectors(session) {
		return store.AgentSession{}, store.ExternalAccount{}, ErrExtensionAccess
	}
	if err := store.RequireDeviceAvailable(ctx, g.store, deviceID); err != nil {
		return store.AgentSession{}, store.ExternalAccount{}, ErrExtensionAccess
	}
	deviceOwner, err := g.store.DeviceOwner(ctx, deviceID)
	if err != nil || deviceOwner != owner {
		return store.AgentSession{}, store.ExternalAccount{}, ErrExtensionAccess
	}
	policy, err := externalaccounts.ResolvePolicy(ctx, g.store, session)
	if err != nil {
		return store.AgentSession{}, store.ExternalAccount{}, err
	}
	account, err := g.store.GetExternalAccount(ctx, accountID)
	if err != nil || account.Provider != kind ||
		!externalaccounts.EligibleFor(account, account.WorkspaceIDs, session.WorkspaceID, owner, deviceOwner, policy) {
		return store.AgentSession{}, store.ExternalAccount{}, ErrExtensionAccess
	}
	app, err := g.store.GetExternalProviderApp(ctx, account.AppID)
	if err != nil {
		return store.AgentSession{}, store.ExternalAccount{}, ErrExtensionAccess
	}
	data, err := g.accounts.ExtensionData(ctx, app)
	if err != nil {
		return store.AgentSession{}, store.ExternalAccount{}, ErrExtensionAccess
	}
	if data.Network == externalaccounts.ExtensionNetworkDevice {
		available := false
		for _, check := range data.AvailableDevices {
			available = available || check.DeviceID == deviceID && check.Status == "ok"
		}
		if !available {
			return store.AgentSession{}, store.ExternalAccount{}, ErrExtensionAccess
		}
	}
	if g.descriptors != nil {
		if _, err := g.descriptors(ctx, deviceID, kind); err != nil {
			return store.AgentSession{}, store.ExternalAccount{}, ErrExtensionAccess
		}
	}
	return session, account, nil
}

func (g *ExtensionGateway) CheckSession(ctx context.Context, kind, sessionID, deviceID, owner, accountID string) (store.ExternalAccount, error) {
	_, account, err := g.sessionAccount(ctx, sessionID, deviceID, owner, accountID, kind)
	return account, err
}

func (g *ExtensionGateway) IssueHandles(ctx context.Context, request externalaccounts.HandleRequest) (store.ExternalAccountGateway, error) {
	kind := request.Account.Provider
	if _, err := g.CheckSession(ctx, kind, request.SessionID, request.DeviceID, request.UserID, request.Account.ID); err != nil {
		return store.ExternalAccountGateway{}, err
	}
	seed := make([]byte, 32)
	if _, err := rand.Read(seed); err != nil {
		return store.ExternalAccountGateway{}, err
	}
	handle := extensionHandlePrefix + base64.RawURLEncoding.EncodeToString(seed)
	if err := g.store.CreateFeishuGatewayGrant(ctx, store.FeishuGatewayGrant{
		SessionID: request.SessionID, AccountID: request.Account.ID, AppID: request.Account.AppID, DeviceID: request.DeviceID,
		WorkspaceID: request.WorkspaceID, UserID: request.UserID,
		UserHash: extensionHandleHash(handle), AppHash: extensionHandleHash(handle + ":unused-app"), TenantHash: extensionHandleHash(handle + ":unused-tenant"),
	}); err != nil {
		return store.ExternalAccountGateway{}, err
	}
	return store.ExternalAccountGateway{
		Path: ExtensionGatewayPath(kind), UserHandle: handle,
		ExpiresAt: g.Now().Add(ExtensionHandleLifetime).UTC().Format(time.RFC3339),
	}, nil
}

type extensionGatewayProvider struct {
	gateway *ExtensionGateway
	kind    string
}

func (p *extensionGatewayProvider) Enter(r *http.Request) gateway.Entry {
	entry := gateway.Entry{Handle: gateway.Bearer(r), Kinds: []string{store.FeishuHandleUser}}
	if r.Body == nil || r.Body == http.NoBody {
		return entry
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxExtensionRequestBody+1))
	_ = r.Body.Close()
	r.Body = io.NopCloser(bytes.NewReader(raw))
	if err != nil || len(raw) > maxExtensionRequestBody {
		entry.Denial = &gateway.Denial{Reason: gateway.ReasonBadRequest, Message: "the connector request body is larger than 8 MiB"}
	}
	return entry
}

func (p *extensionGatewayProvider) Classify(r *http.Request, lease *gateway.Lease) (gateway.Need, *gateway.Denial) {
	data, err := p.gateway.accounts.ExtensionData(r.Context(), lease.App)
	if err != nil {
		return gateway.Need{}, &gateway.Denial{Reason: gateway.ReasonUnavailable, Message: "the connector extension instance metadata could not be read", Err: err}
	}
	call, denial := parseExtensionCall(r, p.kind, data.Descriptor.ServerHeld.Upstream.PathPrefix)
	need := gateway.Need{Payload: call, Detail: &extensionAuditDetail{
		Kind: p.kind, WorkspaceID: lease.Session.WorkspaceID, Method: call.Method, Route: call.Route, Domain: call.Domain, Outcome: "refused",
	}}
	if denial != nil {
		return need, denial
	}
	route, ok := externalaccounts.ExtensionRouteFor(data.Routes, call.Method, call.Path)
	if !ok {
		return need, &gateway.Denial{
			Reason:  gateway.ReasonPathNotAllowed,
			Message: "this route is not in the instance's validated route directory; Foundry only forwards catalogued routes",
		}
	}
	routeLevel := strings.ToLower(strings.TrimSpace(route.Access))
	call.Route, call.Domain, call.Access = route.Path, route.Domain, routeLevel
	need.Level = routeLevel
	need.Write = routeLevel == extensionGatewayWrite
	if need.Write {
		need.Risk = "extension_write"
	}
	need.Detail = &extensionAuditDetail{
		Kind: p.kind, WorkspaceID: lease.Session.WorkspaceID, Method: call.Method, Route: route.Path,
		Access: routeLevel, Write: need.Write, Domain: route.Domain, Outcome: "refused",
	}
	if !externalaccounts.ExtensionAccessAllowsRoute(data.Descriptor.ServerHeld.Access, data.ProbeValues, route) {
		current := externalaccounts.ExtensionAccessLevel(data.Descriptor.ServerHeld.Access, data.ProbeValues)
		return need, &gateway.Denial{
			Reason: gateway.ReasonAccessLevel, Needed: routeLevel, Current: current,
			Message: "the instance classifies " + route.Method + " " + route.Path + " as " + routeLevel + "; its validated token grants " + current + " access",
		}
	}
	return need, nil
}

func (p *extensionGatewayProvider) Holdings(ctx context.Context, lease *gateway.Lease) (gateway.Holdings, *gateway.Denial) {
	data, err := p.gateway.accounts.ExtensionData(ctx, lease.App)
	if err != nil {
		return gateway.Holdings{}, &gateway.Denial{Reason: gateway.ReasonUnavailable, Message: "the connector extension instance metadata could not be read", Err: err}
	}
	level := externalaccounts.ExtensionAccessLevel(data.Descriptor.ServerHeld.Access, data.ProbeValues)
	if level == "" {
		return gateway.Holdings{}, &gateway.Denial{
			Reason: gateway.ReasonAccessEnded, Message: "the connector extension instance has no route access from its validated probe",
		}
	}
	return gateway.Holdings{Level: level}, nil
}

func parseExtensionCall(r *http.Request, kind, pathPrefix string) (*extensionCall, *gateway.Denial) {
	prefix := ExtensionGatewayPath(kind)
	path := strings.TrimPrefix(r.URL.Path, prefix)
	if path == "" {
		path = "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	call := &extensionCall{Method: strings.ToUpper(r.Method), Path: path, Query: r.URL.Query()}
	if strings.ContainsAny(path, "\\\x00\r\n") || strings.Contains(path, "..") ||
		(path != pathPrefix && !strings.HasPrefix(path, strings.TrimRight(pathPrefix, "/")+"/")) {
		return call, &gateway.Denial{Reason: gateway.ReasonPathNotAllowed, Message: "Foundry only forwards the connector's declared path prefix"}
	}
	if len(call.Query) > 40 {
		return call, &gateway.Denial{Reason: gateway.ReasonQueryNotAllow, Message: "too many query parameters"}
	}
	for key, values := range call.Query {
		if len(key) > 200 || len(values) > 20 {
			return call, &gateway.Denial{Reason: gateway.ReasonQueryNotAllow, Message: "a query parameter is too long or repeated too often"}
		}
		for _, value := range values {
			if len(value) > 8<<10 {
				return call, &gateway.Denial{Reason: gateway.ReasonQueryNotAllow, Message: "a query value is longer than 8 KiB"}
			}
		}
	}
	return call, nil
}

func (p *extensionGatewayProvider) Refuse(w http.ResponseWriter, r *http.Request, denial *gateway.Denial) gateway.Refused {
	status := http.StatusForbidden
	message := denial.Message
	switch denial.Reason {
	case gateway.ReasonNoCredential, gateway.ReasonAccessEnded, gateway.ReasonHandleExpired:
		status = http.StatusUnauthorized
		if denial.Reason == gateway.ReasonHandleExpired {
			message = ErrExtensionHandleExpired.Error()
		} else {
			message = ErrExtensionAccess.Error()
		}
	case gateway.ReasonRateLimited:
		status = http.StatusTooManyRequests
		w.Header().Set("Retry-After", strconv.Itoa(int(denial.Wait/time.Second)+1))
		message = "too many connector extension calls from this session; slow down"
	case gateway.ReasonBadRequest:
		status = http.StatusBadRequest
	case gateway.ReasonUnavailable:
		status = http.StatusServiceUnavailable
	case gateway.ReasonInternal:
		status = http.StatusInternalServerError
		message = "Foundry could not check this connector extension request"
	case gateway.ReasonAccessLevel:
		if denial.Current == extensionGatewayRead {
			message = "this instance's validated token is read-only, so Foundry refused a write request"
		} else {
			message = "this request needs " + cmpOrText(denial.Needed, "more") + " access; the instance currently grants " + cmpOrText(denial.Current, "no") + " access"
		}
	case gateway.ReasonConnectorRead:
		message = "the assistant's permission package allows only reads for this connector instance"
	case gateway.ReasonNeedsConfirmation:
		message = "this connector write needs confirmation before Foundry sends it"
		if denial.ProposalID != "" {
			message = cmpOrText(denial.Summary, "This connector write needs confirmation") +
				" Accept proposal " + denial.ProposalID + " before repeating this exact request."
		}
	}
	if message == "" {
		message = "Foundry refused this connector extension request"
	}
	return writeExtensionGatewayError(w, status, denial.Reason, denial.Needed, denial.Current, message)
}

func (p *extensionGatewayProvider) Upstream(w http.ResponseWriter, r *http.Request, x *gateway.Exchange) *gateway.Denial {
	call := x.Need.Payload.(*extensionCall)
	data, err := p.gateway.accounts.ExtensionData(r.Context(), x.Lease.App)
	if err != nil {
		return &gateway.Denial{Reason: gateway.ReasonUnavailable, Message: "the connector extension instance metadata could not be read", Err: err}
	}
	requestLimit := data.Descriptor.ServerHeld.Upstream.RequestBodyLimitBytes
	if requestLimit == 0 {
		requestLimit = maxExtensionRequestBody
	}
	if requestLimit > maxExtensionRequestBody {
		requestLimit = maxExtensionRequestBody
	}
	var body io.Reader = r.Body
	if r.Body != nil && r.Body != http.NoBody {
		raw, err := io.ReadAll(io.LimitReader(r.Body, int64(requestLimit)+1))
		if err != nil || len(raw) > requestLimit {
			return &gateway.Denial{Reason: gateway.ReasonBadRequest, Message: "the connector request body is larger than this instance accepts"}
		}
		body = bytes.NewReader(raw)
	}
	headers := make(http.Header)
	for name, values := range r.Header {
		switch http.CanonicalHeaderKey(name) {
		case "X-Foundry-Device-Credential", "X-Foundry-Forwarder-Host", "Authorization", "Cookie", "Host":
			continue
		}
		for _, value := range values {
			headers.Add(name, value)
		}
	}
	timeout := time.Duration(data.Descriptor.ServerHeld.Upstream.TimeoutSeconds) * time.Second
	if timeout <= 0 || timeout > 60*time.Second {
		timeout = 60 * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	response, err := p.gateway.accounts.DoExtensionRequest(ctx, x.Lease.App, x.Lease.Grant.DeviceID, call.Method, call.Path, call.Query, headers, body)
	if err != nil {
		status, message := http.StatusBadGateway, "the connector could not be reached"
		var probeErr *externalaccounts.ExtensionProbeError
		if errors.As(err, &probeErr) {
			message = probeErr.Message
			if probeErr.EdgeAccess != nil {
				x.Outcome, x.Status = gateway.OutcomeUpstreamError, status
				writeExtensionEdgeAccessRequired(w, status, probeErr.EdgeAccess)
				return nil
			}
		}
		x.Outcome, x.Status = gateway.OutcomeUpstreamError, status
		writeExtensionGatewayError(w, status, gateway.ReasonUnavailable, "", "", message)
		return nil
	}
	defer response.Body.Close()
	responseLimit := data.Descriptor.ServerHeld.Upstream.ResponseBodyLimitBytes
	if responseLimit == 0 {
		responseLimit = extensionDefaultResponseMax
	}
	if responseLimit > extensionDefaultResponseMax {
		responseLimit = extensionDefaultResponseMax
	}
	payload, readErr := io.ReadAll(io.LimitReader(response.Body, int64(responseLimit)+1))
	if readErr != nil {
		x.Outcome, x.Status = gateway.OutcomeUpstreamError, http.StatusBadGateway
		writeExtensionGatewayError(w, http.StatusBadGateway, gateway.ReasonUnavailable, "", "", "the connector response could not be read")
		return nil
	}
	if len(payload) > responseLimit {
		x.Outcome, x.Status = gateway.OutcomeUpstreamError, http.StatusBadGateway
		writeExtensionGatewayError(w, http.StatusBadGateway, gateway.ReasonUnavailable, "", "", "the connector response is larger than this instance accepts")
		return nil
	}
	for name, values := range response.Header {
		switch http.CanonicalHeaderKey(name) {
		case "Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade", "Set-Cookie":
			continue
		}
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
	x.Status = response.StatusCode
	if response.StatusCode >= 400 {
		x.Outcome = gateway.OutcomeUpstreamError
	}
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(payload)
	return nil
}

const extensionDefaultResponseMax = 16 << 20

func writeExtensionGatewayError(w http.ResponseWriter, status int, reason, needed, current, message string) gateway.Refused {
	code := strings.ToUpper(strings.ReplaceAll(cmpOrText(reason, gateway.ReasonBlocked), "-", "_"))
	recoverable := status == http.StatusTooManyRequests || status == http.StatusServiceUnavailable
	body := map[string]any{
		"error": map[string]any{
			"code":        "FOUNDRY_" + code,
			"message":     message,
			"recoverable": recoverable,
		},
		"foundry": map[string]any{
			"refused": true, "reason": cmpOrText(reason, gateway.ReasonBlocked),
			"needed": needed, "current": current,
			"where": "Connectors → this workspace → Private connector",
		},
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
	return gateway.Refused{Status: status, Message: message}
}

// writeExtensionEdgeAccessRequired answers a call whose upstream sits behind an
// edge (Cloudflare Access) that wants a credential Foundry cannot present.
func writeExtensionEdgeAccessRequired(w http.ResponseWriter, status int, required *store.EdgeAccessRequired) {
	body := map[string]any{
		"error": map[string]any{
			"code": "FOUNDRY_EDGE_ACCESS_REQUIRED", "message": required.Message, "recoverable": false,
		},
		"foundry":    map[string]any{"refused": true, "reason": "edge_access_required", "where": "Settings → Edge access"},
		"edgeAccess": required,
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

type extensionAudit struct{ gateway *ExtensionGateway }

func (a extensionAudit) Record(ctx context.Context, record gateway.Record) {
	grant := record.Grant
	if record.Lease != nil {
		grant = &record.Lease.Grant
	}
	if grant == nil {
		return
	}
	call, _ := record.Need.Payload.(*extensionCall)
	detail := &extensionAuditDetail{
		Kind: kindOfExtensionGatewayPath(record.Request.URL.Path), WorkspaceID: grant.WorkspaceID,
		Method: record.Request.Method, Status: record.Status, Outcome: record.Outcome,
	}
	if record.Lease != nil {
		detail.Kind, detail.WorkspaceID = record.Lease.Account.Provider, record.Lease.Session.WorkspaceID
	}
	if call == nil {
		detail.Route = extensionGatewayRest(record.Request.URL.Path)
	}
	if call != nil {
		detail.Route, detail.Domain, detail.Access = call.Route, call.Domain, call.Access
		detail.Write = record.Need.Write
		if detail.Route == "" {
			detail.Route = call.Path
		}
	}
	if record.Denial != nil {
		detail.Error = truncateExtensionAudit(record.Denial.Reason + ": " + record.Message)
	}
	if len(detail.Route) > 300 {
		detail.Route = detail.Route[:300]
	}
	line, _ := json.Marshal(detail)
	event := store.ExternalAccountEvent{
		AccountID: grant.AccountID, Kind: "extension_connector_request",
		SessionID: grant.SessionID, DeviceID: grant.DeviceID,
		ActorID: record.Device.OwnerUserID, Detail: string(line),
	}
	audit, done := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer done()
	_ = a.gateway.store.AppendExternalAccountEvent(audit, event)
}

// kindOfExtensionGatewayPath is the connector kind in a gateway path
// (/api/connectors/extensions/<kind>/gateway/…).
func kindOfExtensionGatewayPath(path string) string {
	rest, ok := strings.CutPrefix(path, "/api/connectors/extensions/")
	if !ok {
		return ""
	}
	kind, _, _ := strings.Cut(rest, "/")
	if unescaped, err := url.PathUnescape(kind); err == nil {
		return unescaped
	}
	return kind
}

// extensionGatewayRest is the upstream path of a gateway path.
func extensionGatewayRest(path string) string {
	if _, rest, ok := strings.Cut(path, "/gateway"); ok && strings.HasPrefix(path, "/api/connectors/extensions/") {
		return rest
	}
	return path
}

func truncateExtensionAudit(message string) string {
	message = strings.Join(strings.Fields(message), " ")
	if len(message) > 500 {
		return message[:500]
	}
	return message
}

func cmpOrText(value, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}
