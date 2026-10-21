package connectors

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
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
}

func NewCloudflareGateway(st CloudflareStore, accounts *externalaccounts.Service) *CloudflareGateway {
	return &CloudflareGateway{store: st, accounts: accounts, Now: time.Now}
}
func cloudflareHash(handle string) string {
	sum := sha256.Sum256([]byte(handle))
	return hex.EncodeToString(sum[:])
}

// CheckSession is repeated for every call and every handle renewal; the local
// tool holds no provider credential. Binding removal has immediate effect.
func (g *CloudflareGateway) CheckSession(ctx context.Context, sessionID, deviceID, owner, accountID string) (store.ExternalAccount, []string, error) {
	session, err := g.store.GetAgentSessionSummary(ctx, sessionID)
	if err != nil || session.DeviceID != deviceID || session.CreatedByUserID != owner || sandboxedRole(session.Role) || session.IssueID != "" || session.Source == "verification" || session.Source == "diagnostic" || session.Source == "naming" || session.Source == "digest" || (session.Status != "running" && session.Status != "queued" && session.Status != "blocked") {
		return store.ExternalAccount{}, nil, ErrCloudflareAccess
	}
	if err := store.RequireDeviceAvailable(ctx, g.store, deviceID); err != nil {
		return store.ExternalAccount{}, nil, ErrCloudflareAccess
	}
	deviceOwner, err := g.store.DeviceOwner(ctx, deviceID)
	if err != nil || deviceOwner != owner {
		return store.ExternalAccount{}, nil, ErrCloudflareAccess
	}
	account, err := g.store.GetExternalAccount(ctx, accountID)
	if err != nil || account.Provider != "cloudflare" || !externalaccounts.Eligible(account, account.WorkspaceIDs, session.WorkspaceID, owner, deviceOwner) {
		return store.ExternalAccount{}, nil, ErrCloudflareAccess
	}
	bindings, err := g.store.ListWorkspaceExternalAccounts(ctx, session.WorkspaceID)
	if err != nil {
		return store.ExternalAccount{}, nil, err
	}
	for _, b := range bindings {
		if b.AccountID == accountID && b.GrantedBy == owner && len(b.ResourceIDs) > 0 {
			return account, b.ResourceIDs, nil
		}
	}
	return store.ExternalAccount{}, nil, ErrCloudflareAccess
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

func (g *CloudflareGateway) ReadHandle(ctx context.Context, handle, deviceID, owner, path string, query url.Values) (json.RawMessage, error) {
	if !strings.HasPrefix(handle, cloudflareHandlePrefix) {
		return nil, ErrCloudflareAccess
	}
	grant, err := g.store.FindFeishuGatewayGrant(ctx, store.FeishuHandleUser, cloudflareHash(handle))
	if err != nil || grant.DeviceID != deviceID || grant.UserID != owner {
		return nil, ErrCloudflareAccess
	}
	session, err := g.store.GetAgentSessionSummary(ctx, grant.SessionID)
	if err != nil || session.WorkspaceID != grant.WorkspaceID {
		return nil, ErrCloudflareAccess
	}
	created, err := time.Parse(time.RFC3339Nano, grant.CreatedAt)
	if err != nil || g.Now().After(created.Add(CloudflareHandleLifetime)) {
		return nil, ErrCloudflareHandleExpired
	}
	return g.ReadSession(ctx, grant.SessionID, deviceID, owner, grant.AccountID, path, query)
}

func (g *CloudflareGateway) ReadSession(ctx context.Context, sessionID, deviceID, owner, accountID, path string, query url.Values) (result json.RawMessage, err error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	account, resources, err := g.CheckSession(ctx, sessionID, deviceID, owner, accountID)
	if err != nil {
		return nil, err
	}
	outcome := "refused"
	defer func() {
		_ = g.store.AppendExternalAccountEvent(ctx, store.ExternalAccountEvent{AccountID: account.ID, Kind: "cloudflare_request", SessionID: sessionID, DeviceID: deviceID, ActorID: owner, Detail: "GET " + cloudflareAuditPath(path) + " " + outcome})
	}()
	if err = validateCloudflareRead(path, query, resources); err != nil {
		return nil, err
	}
	use := externalaccounts.Use{SessionID: sessionID, DeviceID: deviceID, By: "session"}
	if path == "/zones" {
		// Enumerate only selected zones. Never request a broader upstream account
		// list and merely hide its extra records afterward.
		zones := []json.RawMessage{}
		for _, id := range resources {
			data, e := g.accounts.CloudflareRead(ctx, account, "/zones/"+id, nil, use)
			if e != nil {
				return nil, e
			}
			var envelope struct {
				Result json.RawMessage `json:"result"`
			}
			if json.Unmarshal(data, &envelope) != nil || len(envelope.Result) == 0 {
				return nil, errors.New("Cloudflare returned no zone")
			}
			zones = append(zones, envelope.Result)
		}
		page, perPage := cloudflareZonePage(query)
		start := min((page-1)*perPage, len(zones))
		pageZones := zones[start:min(start+perPage, len(zones))]
		result, err = json.Marshal(map[string]any{"success": true, "errors": []any{}, "messages": []any{}, "result": pageZones, "result_info": map[string]int{"page": page, "per_page": perPage, "count": len(pageZones), "total_count": len(zones), "total_pages": max(1, (len(zones)+perPage-1)/perPage)}})
	} else {
		result, err = g.accounts.CloudflareRead(ctx, account, path, query, use)
	}
	if err != nil {
		outcome = "upstream_error"
	} else {
		outcome = "forwarded"
	}
	return result, err
}
func validateCloudflareRead(path string, query url.Values, resources []string) error {
	if strings.ContainsAny(path, "\\%?#\x00\r\n") || strings.Contains(path, "..") {
		return ErrCloudflareAccess
	}
	for key, values := range query {
		if len(key) > 80 || len(values) != 1 || len(values[0]) > 256 {
			return ErrCloudflareAccess
		}
		switch key {
		case "page", "per_page", "name", "type", "status", "order", "direction", "match":
		default:
			return ErrCloudflareAccess
		}
	}
	if path == "/zones" {
		for key := range query {
			if key != "page" && key != "per_page" {
				return errors.New("bound zone listing supports only page and per_page")
			}
		}
		for _, key := range []string{"page", "per_page"} {
			if query.Get(key) != "" {
				n, e := strconv.Atoi(query.Get(key))
				if e != nil || n < 1 || n > 10000 || (key == "per_page" && n > 50) {
					return ErrCloudflareAccess
				}
			}
		}
		return nil
	}
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(parts) < 2 || parts[0] != "zones" || !cloudflareZoneID.MatchString(parts[1]) {
		return ErrCloudflareAccess
	}
	found := false
	for _, id := range resources {
		if id == parts[1] {
			found = true
		}
	}
	if !found {
		return ErrCloudflareAccess
	}
	suffix := strings.Join(parts[2:], "/")
	switch suffix {
	case "", "dns_records", "ssl/certificate_packs", "ssl/universal/settings", "ssl/verification", "settings/ssl", "subscription", "pagerules", "workers/routes", "rulesets/phases/http_request_cache_settings/entrypoint":
		return nil
	}
	if len(parts) == 4 && parts[2] == "dns_records" && cloudflareZoneID.MatchString(parts[3]) {
		return nil
	}
	return ErrCloudflareAccess
}
func cloudflareAuditPath(path string) string {
	if path == "/zones" {
		return "/zones"
	}
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(parts) < 2 || parts[0] != "zones" || !cloudflareZoneID.MatchString(parts[1]) {
		return "unsupported_path"
	}
	if validateCloudflareRead(path, nil, []string{parts[1]}) != nil {
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
