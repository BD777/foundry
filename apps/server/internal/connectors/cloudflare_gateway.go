package connectors

import (
	"cmp"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const CloudflareGatewayPath = "/api/connectors/cloudflare/gateway"
const cloudflareHandlePrefix = "fdycf_user_"
const CloudflareHandleLifetime = 30 * time.Minute

var ErrCloudflareAccess = errors.New("this session has no current Cloudflare grant for the selected resource")
var ErrCloudflareHandleExpired = errors.New("Cloudflare session handle expired; refresh the session handle")
var cloudflareZoneID = regexp.MustCompile(`^[a-f0-9]{32}$`)

type CloudflareStore interface {
	store.ExternalAccountStore
	store.FeishuGatewayStore // shared hashed session-handle persistence; legacy table name
	GetAgentSessionSummary(context.Context, string) (store.AgentSession, error)
	DeviceOwner(context.Context, string) (string, error)
	DeviceRemoved(context.Context, string) (bool, error)
}

type CloudflareGateway struct {
	store    CloudflareStore
	accounts *externalaccounts.Service
	Now      func() time.Time

	pipeline *gateway.Pipeline

	zoneAccountsMu sync.Mutex
	zoneAccounts   map[string]string
}

// cloudflareSessionRate is the common limit on a session's calls through the
// gateway (the same default as the Feishu gateway's per-session limit);
// Cloudflare's own limits still apply behind it.
var cloudflareSessionRate = gateway.Rate{PerSecond: 20, Burst: 60}

func NewCloudflareGateway(st CloudflareStore, accounts *externalaccounts.Service) *CloudflareGateway {
	g := &CloudflareGateway{store: st, accounts: accounts, Now: time.Now, zoneAccounts: map[string]string{}}
	g.pipeline = &gateway.Pipeline{
		Scheme: gateway.Scheme{
			Provider: "cloudflare", Kind: cloudflareHandleKind, Hash: cloudflareHash,
			Bearer: []string{store.FeishuHandleUser}, Lifetime: CloudflareHandleLifetime,
		},
		Provider: g, Sessions: st, Grants: st, Accounts: st, Audit: cloudflareAudit{g},
		Levels:      externalaccounts.CloudflareAccessLevels,
		Limits:      []gateway.Limit{cloudflareSessionRate.PerKey(func(l *gateway.Lease) string { return l.Grant.SessionID })},
		Unavailable: func() error { return g.accounts.Integrations.Err() },
		Now:         func() time.Time { return g.Now() },
		Logf:        log.Printf,
	}
	return g
}

// Serve answers one request under CloudflareGatewayPath from an
// authenticated device: the one way a session's call reaches Cloudflare.
func (g *CloudflareGateway) Serve(w http.ResponseWriter, r *http.Request, device gateway.Device) {
	g.pipeline.Serve(w, r, device)
}

func cloudflareHandleKind(handle string) string {
	if strings.HasPrefix(handle, cloudflareHandlePrefix) {
		return store.FeishuHandleUser
	}
	return ""
}
func cloudflareHash(handle string) string {
	sum := sha256.Sum256([]byte(handle))
	return hex.EncodeToString(sum[:])
}

// cloudflareBinding is the Cloudflare identity a session acts as: the
// account with its workspace's binding. A workspace binds at most one
// Cloudflare identity (SetWorkspaceExternalAccounts refuses a second), so a
// session never has to choose between identities.
type cloudflareBinding struct {
	account store.ExternalAccount
	binding store.ExternalAccountBinding
}

func accessOf(binding store.ExternalAccountBinding) string {
	return cmp.Or(binding.Access, externalaccounts.CloudflareAccessRead)
}

// UseNativeWork lets a completed session act, and renew its handle, while
// its device claims that the session's agent still works on its own
// (gateway.SessionLive).
func (g *CloudflareGateway) UseNativeWork(work gateway.NativeWork) {
	g.pipeline.Work = work
}

// sessionBinding is the first step of every handle issue and renewal: the
// session must be its owner's, live (gateway.SessionLive), on the owner's
// available device, and its workspace must bind a Cloudflare identity that
// Eligible allows. (The
// requests of a session go through the gateway pipeline, which asks the
// same of the grant it authenticates: gateway.Pipeline.Live, then
// bindingFor.) The local tool holds no provider credential, and a binding
// removed has immediate effect.
func (g *CloudflareGateway) sessionBinding(ctx context.Context, sessionID, deviceID, owner string) (store.AgentSession, cloudflareBinding, error) {
	session, err := g.store.GetAgentSessionSummary(ctx, sessionID)
	if err != nil || session.DeviceID != deviceID || session.CreatedByUserID != owner || gateway.SessionLive(session, g.pipeline.Work, g.Now()) != nil {
		return store.AgentSession{}, cloudflareBinding{}, ErrCloudflareAccess
	}
	bound, err := g.bindingFor(ctx, session, deviceID, owner)
	return session, bound, err
}

// bindingFor is the Cloudflare identity session acts as: the workspace's
// binding of an account Eligible allows. The session may take connectors at
// all, and its device must still be the owner's and available.
func (g *CloudflareGateway) bindingFor(ctx context.Context, session store.AgentSession, deviceID, owner string) (cloudflareBinding, error) {
	none := cloudflareBinding{}
	if !takesConnectors(session) {
		return none, ErrCloudflareAccess
	}
	if err := store.RequireDeviceAvailable(ctx, g.store, deviceID); err != nil {
		return none, ErrCloudflareAccess
	}
	deviceOwner, err := g.store.DeviceOwner(ctx, deviceID)
	if err != nil || deviceOwner != owner {
		return none, ErrCloudflareAccess
	}
	bindings, err := g.store.ListWorkspaceExternalAccounts(ctx, session.WorkspaceID)
	if err != nil {
		return none, err
	}
	for _, b := range bindings {
		if b.GrantedBy != owner || len(b.ResourceIDs) == 0 {
			continue
		}
		account, err := g.store.GetExternalAccount(ctx, b.AccountID)
		if err == nil && account.Provider == "cloudflare" && externalaccounts.Eligible(account, account.WorkspaceIDs, session.WorkspaceID, owner, deviceOwner) {
			return cloudflareBinding{account, b}, nil
		}
	}
	return none, &CloudflareRefusal{Message: "this session has no Cloudflare identity bound to its workspace; the account owner binds zones in Connectors → this workspace → Cloudflare", Reason: RefusalNoGrant}
}

// CheckSession says whether the session may act as accountID now, and with
// which zones.
func (g *CloudflareGateway) CheckSession(ctx context.Context, sessionID, deviceID, owner, accountID string) (store.ExternalAccount, []string, error) {
	_, bound, err := g.sessionBinding(ctx, sessionID, deviceID, owner)
	if err != nil {
		return store.ExternalAccount{}, nil, err
	}
	if bound.account.ID != accountID {
		return store.ExternalAccount{}, nil, ErrCloudflareAccess
	}
	return bound.account, bound.binding.ResourceIDs, nil
}

func (g *CloudflareGateway) IssueHandles(ctx context.Context, r externalaccounts.HandleRequest) (store.ExternalAccountGateway, error) {
	if _, _, err := g.CheckSession(ctx, r.SessionID, r.DeviceID, r.UserID, r.Account.ID); err != nil {
		return store.ExternalAccountGateway{}, err
	}
	seed := make([]byte, 32)
	if _, err := rand.Read(seed); err != nil {
		return store.ExternalAccountGateway{}, err
	}
	handle := cloudflareHandlePrefix + base64.RawURLEncoding.EncodeToString(seed)
	if err := g.store.CreateFeishuGatewayGrant(ctx, store.FeishuGatewayGrant{SessionID: r.SessionID, AccountID: r.Account.ID, AppID: r.Account.AppID, DeviceID: r.DeviceID, WorkspaceID: r.WorkspaceID, UserID: r.UserID, UserHash: cloudflareHash(handle), AppHash: cloudflareHash(handle + ":unused-app"), TenantHash: cloudflareHash(handle + ":unused-tenant")}); err != nil {
		return store.ExternalAccountGateway{}, err
	}
	return store.ExternalAccountGateway{Path: CloudflareGatewayPath, UserHandle: handle, ExpiresAt: g.Now().Add(CloudflareHandleLifetime).UTC().Format(time.RFC3339)}, nil
}

// audit records line on the account the call was made as.
func (g *CloudflareGateway) audit(ctx context.Context, accountID string, event store.ExternalAccountEvent) {
	// The caller's context may be over; the line is still written.
	audit, done := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer done()
	event.AccountID = accountID
	_ = g.store.AppendExternalAccountEvent(audit, event)
}

// listZones answers GET /zones from the zones the workspace bound, never
// from an upstream account listing: each bound zone is read by id, then
// filtered (name, as cf resolves a domain to its zone) and paged here.
func (g *CloudflareGateway) listZones(ctx context.Context, account store.ExternalAccount, zones []string, query url.Values, use externalaccounts.Use) (json.RawMessage, error) {
	type zone struct {
		name string
		raw  json.RawMessage
	}
	listed := []zone{}
	accountFilter := query.Get("account.id")
	for _, id := range zones {
		data, err := g.accounts.CloudflareRead(ctx, account, "/zones/"+id, nil, use)
		if err != nil {
			return nil, err
		}
		var envelope struct {
			Result json.RawMessage `json:"result"`
		}
		var named struct {
			Name    string `json:"name"`
			Account struct {
				ID string `json:"id"`
			} `json:"account"`
		}
		if json.Unmarshal(data, &envelope) != nil || len(envelope.Result) == 0 || json.Unmarshal(envelope.Result, &named) != nil {
			return nil, errors.New("Cloudflare returned no zone")
		}
		if accountFilter != "" && named.Account.ID != accountFilter {
			continue
		}
		listed = append(listed, zone{named.Name, envelope.Result})
	}
	if name := strings.TrimSpace(query.Get("name")); name != "" {
		listed = slices.DeleteFunc(listed, func(z zone) bool { return !zoneNameMatches(z.name, name) })
	}
	page, perPage := cloudflareZonePage(query)
	start := min((page-1)*perPage, len(listed))
	pageZones := []json.RawMessage{}
	for _, z := range listed[start:min(start+perPage, len(listed))] {
		pageZones = append(pageZones, z.raw)
	}
	return json.Marshal(map[string]any{"success": true, "errors": []any{}, "messages": []any{}, "result": pageZones, "result_info": map[string]int{"page": page, "per_page": perPage, "count": len(pageZones), "total_count": len(listed), "total_pages": max(1, (len(listed)+perPage-1)/perPage)}})
}

// zoneNameMatches is Cloudflare's zone `name` filter: a domain (equal), or
// an operator and a value ("contains:example"); the case-sensitive operators
// carry the suffix _case_sensitive.
func zoneNameMatches(name, filter string) bool {
	operator, value, hasOperator := strings.Cut(filter, ":")
	if !hasOperator {
		return strings.EqualFold(name, filter)
	}
	sensitive := strings.HasSuffix(operator, "_case_sensitive")
	operator = strings.TrimSuffix(operator, "_case_sensitive")
	if !sensitive {
		name, value = strings.ToLower(name), strings.ToLower(value)
	}
	switch operator {
	case "equal":
		return name == value
	case "not_equal":
		return name != value
	case "starts_with":
		return strings.HasPrefix(name, value)
	case "ends_with":
		return strings.HasSuffix(name, value)
	case "contains":
		return strings.Contains(name, value)
	}
	return strings.EqualFold(name, filter)
}

// validateCloudflareRead is the shape of a read: a path and query a session
// may use. Which identity it is for is decided after, by the zone it names.
func validateCloudflareRead(path string, query url.Values) error {
	if strings.ContainsAny(path, "\\%?#\x00\r\n") || strings.Contains(path, "..") {
		return &CloudflareRefusal{Message: "the path holds characters Foundry does not forward", Reason: RefusalPathNotAllowed}
	}
	for key, values := range query {
		if len(key) > 80 || len(values) != 1 || len(values[0]) > 256 {
			return &CloudflareRefusal{Message: "query parameter " + key + " is not accepted: one value of at most 256 characters", Reason: RefusalQueryNotAllow}
		}
		switch key {
		case "page", "per_page", "name", "type", "status", "order", "direction", "match", "account.id":
		default:
			return &CloudflareRefusal{Message: "query parameter " + key + " is not accepted; reads take page, per_page, name, type, status, order, direction, match and account.id", Reason: RefusalQueryNotAllow}
		}
	}
	if path == "/zones" {
		for key := range query {
			if key != "page" && key != "per_page" && key != "name" && key != "account.id" {
				return &CloudflareRefusal{Message: "listing the bound zones takes only page, per_page, name and account.id", Reason: RefusalQueryNotAllow}
			}
		}
		if id := query.Get("account.id"); id != "" && !cloudflareZoneID.MatchString(id) {
			return &CloudflareRefusal{Message: "account.id must be a Cloudflare account id", Reason: RefusalQueryNotAllow}
		}
		for _, key := range []string{"page", "per_page"} {
			if query.Get(key) != "" {
				n, e := strconv.Atoi(query.Get(key))
				if e != nil || n < 1 || n > 10000 || (key == "per_page" && n > 50) {
					return &CloudflareRefusal{Message: key + " must be a number from 1 (per_page at most 50)", Reason: RefusalQueryNotAllow}
				}
			}
		}
		return nil
	}
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(parts) < 2 || parts[0] != "zones" || !cloudflareZoneID.MatchString(parts[1]) {
		return &CloudflareRefusal{Message: "GET " + shown(path) + " is outside what a workspace's Cloudflare access reads: /zones and the DNS, SSL and settings of a bound zone by its zone ID (a zone's ID comes from GET /zones?name=<domain>, as in cf zones list --name <domain>)", Reason: RefusalPathNotAllowed}
	}
	suffix := strings.Join(parts[2:], "/")
	switch suffix {
	case "", "dns_records", "ssl/certificate_packs", "ssl/universal/settings", "ssl/verification", "settings/ssl", "subscription", "pagerules", "workers/routes", "rulesets/phases/http_request_cache_settings/entrypoint":
		return nil
	}
	if len(parts) == 4 && parts[2] == "dns_records" && cloudflareZoneID.MatchString(parts[3]) {
		return nil
	}
	return &CloudflareRefusal{Message: "GET /zones/:id/" + suffix + " is outside what a workspace's Cloudflare access reads: a zone's DNS records, SSL and certificate metadata, subscription, page rules, Workers routes and the cache ruleset", Reason: RefusalPathNotAllowed}
}
func cloudflareAuditPath(path string) string {
	if path == "/zones" {
		return "/zones"
	}
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(parts) < 2 || parts[0] != "zones" || !cloudflareZoneID.MatchString(parts[1]) {
		return "unsupported_path"
	}
	if validateCloudflareRead(path, nil) != nil {
		return "unsupported_path"
	}
	parts[1] = ":id"
	if len(parts) == 4 && parts[2] == "dns_records" {
		parts[3] = ":id"
	}
	return "/" + strings.Join(parts, "/")
}

type connectorHandleIssuer struct {
	cloudflare *CloudflareGateway
	other      externalaccounts.HandleIssuer
}

func (i connectorHandleIssuer) IssueHandles(ctx context.Context, r externalaccounts.HandleRequest) (store.ExternalAccountGateway, error) {
	if r.Account.Provider == "cloudflare" {
		if i.cloudflare == nil {
			return store.ExternalAccountGateway{}, ErrCloudflareAccess
		}
		return i.cloudflare.IssueHandles(ctx, r)
	}
	return i.other.IssueHandles(ctx, r)
}
func (m *Module) SetGatewayIssuer(fallback externalaccounts.HandleIssuer) {
	m.ServerHeld.Handles = connectorHandleIssuer{cloudflare: m.Cloudflare, other: fallback}
}

func cloudflareZonePage(query url.Values) (page, perPage int) {
	page, perPage = 1, 20
	if value := query.Get("page"); value != "" {
		page, _ = strconv.Atoi(value)
	}
	if value := query.Get("per_page"); value != "" {
		perPage, _ = strconv.Atoi(value)
	}
	return
}

// shown is a caller's path as a refusal quotes it.
func shown(path string) string {
	path = strings.Map(func(r rune) rune {
		if r < 0x20 {
			return ' '
		}
		return r
	}, path)
	if len(path) > 120 {
		path = path[:120] + "…"
	}
	return path
}

// ProviderAccountID is the Cloudflare account that every zone the session's
// workspace binds belongs to, which the official cf CLI is told as
// CLOUDFLARE_ACCOUNT_ID (without it, cf looks a zone up by domain by listing
// the identity's accounts first, which the gateway does not forward). It is
// "" when the zones span several accounts or an account cannot be told; it is
// not a secret. A zone's account does not change, so it is remembered.
func (g *CloudflareGateway) ProviderAccountID(ctx context.Context, session store.AgentSession, deviceOwner string) string {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	_, bound, err := g.sessionBinding(ctx, session.ID, session.DeviceID, deviceOwner)
	if err != nil {
		return ""
	}
	use := externalaccounts.Use{SessionID: session.ID, DeviceID: session.DeviceID, By: "session"}
	found := ""
	for _, zone := range bound.binding.ResourceIDs {
		account := g.zoneAccount(ctx, bound.account, zone, use)
		if account == "" || (found != "" && account != found) {
			return ""
		}
		found = account
	}
	return found
}

func (g *CloudflareGateway) zoneAccount(ctx context.Context, account store.ExternalAccount, zone string, use externalaccounts.Use) string {
	g.zoneAccountsMu.Lock()
	known := g.zoneAccounts[zone]
	g.zoneAccountsMu.Unlock()
	if known != "" {
		return known
	}
	data, err := g.accounts.CloudflareRead(ctx, account, "/zones/"+zone, nil, use)
	if err != nil {
		return ""
	}
	var envelope struct {
		Result struct {
			Account struct {
				ID string `json:"id"`
			} `json:"account"`
		} `json:"result"`
	}
	if json.Unmarshal(data, &envelope) != nil || !cloudflareZoneID.MatchString(envelope.Result.Account.ID) {
		return ""
	}
	g.zoneAccountsMu.Lock()
	g.zoneAccounts[zone] = envelope.Result.Account.ID
	g.zoneAccountsMu.Unlock()
	return envelope.Result.Account.ID
}
