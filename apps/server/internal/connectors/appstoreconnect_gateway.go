package connectors

import (
	"bytes"
	"cmp"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	AppStoreConnectGatewayPath    = "/api/connectors/appstoreconnect/gateway"
	appStoreConnectHandlePrefix   = "fdyasc_user_"
	AppStoreConnectHandleLifetime = 30 * time.Minute
	appStoreConnectReadLevel      = "read"
	appStoreConnectCommerceLevel  = "commerce"
	maxAppStoreConnectBody        = 256 << 10
	appStoreConnectLookupTTL      = 5 * time.Minute
)

var (
	ErrAppStoreConnectAccess        = errors.New("this session has no current App Store Connect grant for the selected app")
	ErrAppStoreConnectHandleExpired = errors.New("App Store Connect session handle expired; refresh the session handle")
)

type AppStoreConnectGatewayStore interface {
	store.ExternalAccountStore
	store.FeishuGatewayStore
	externalaccounts.ConnectorAccessStore
	GetAgentSessionSummary(context.Context, string) (store.AgentSession, error)
	DeviceOwner(context.Context, string) (string, error)
	DeviceRemoved(context.Context, string) (bool, error)
}

type appStoreConnectBinding struct {
	Account   store.ExternalAccount
	Access    string
	AppIDs    []string
	Workspace string
}

type appStoreConnectLookup struct {
	AppID   string
	Expires time.Time
}

type AppStoreConnectGateway struct {
	store    AppStoreConnectGatewayStore
	accounts *externalaccounts.Service
	Now      func() time.Time

	pipeline *gateway.Pipeline

	lookupMu sync.Mutex
	lookups  map[string]appStoreConnectLookup
}

type appStoreConnectCall struct {
	Method     string
	Path       string
	Query      url.Values
	Body       json.RawMessage
	TopType    string
	ResourceID string
	AppID      string
}

type AppStoreConnectAuditDetail struct {
	WorkspaceID string `json:"workspaceId"`
	AppID       string `json:"appId,omitempty"`
	Method      string `json:"method"`
	Path        string `json:"path"`
	Status      int    `json:"status,omitempty"`
	Outcome     string `json:"outcome"`
	Error       string `json:"error,omitempty"`
}

var appStoreConnectSessionRate = gateway.Rate{PerSecond: 20, Burst: 60}

func NewAppStoreConnectGateway(st AppStoreConnectGatewayStore, accounts *externalaccounts.Service) *AppStoreConnectGateway {
	if st == nil {
		panic("NewAppStoreConnectGateway requires a store that resolves connector access")
	}
	g := &AppStoreConnectGateway{store: st, accounts: accounts, Now: time.Now, lookups: map[string]appStoreConnectLookup{}}
	g.pipeline = &gateway.Pipeline{
		Scheme: gateway.Scheme{
			Provider: "appstoreconnect", Kind: appStoreConnectHandleKind, Hash: appStoreConnectHash,
			Bearer: []string{store.FeishuHandleUser}, Lifetime: AppStoreConnectHandleLifetime,
		},
		Provider: g, Sessions: st, Grants: st, Accounts: st, Access: st, Audit: appStoreConnectAudit{g},
		Levels:      externalaccounts.AppStoreConnectAccessLevels,
		Limits:      []gateway.Limit{appStoreConnectSessionRate.PerKey(func(l *gateway.Lease) string { return l.Grant.SessionID })},
		Unavailable: func() error { return g.accounts.Integrations.Err() },
		Now:         func() time.Time { return g.Now() },
		Logf:        log.Printf,
	}
	return g
}

func (g *AppStoreConnectGateway) Serve(w http.ResponseWriter, r *http.Request, device gateway.Device) {
	g.pipeline.Serve(w, r, device)
}

// UsePermission makes every gateway call re-read the assistant package and
// route risk writes through confirmation.
func (g *AppStoreConnectGateway) UsePermission(st permission.Store, confirm gateway.Confirmer) {
	g.pipeline.Permission = st
	g.pipeline.Confirm = confirm
}

func appStoreConnectHandleKind(handle string) string {
	if strings.HasPrefix(handle, appStoreConnectHandlePrefix) {
		return store.FeishuHandleUser
	}
	return ""
}

func appStoreConnectHash(handle string) string {
	sum := sha256.Sum256([]byte(handle))
	return hex.EncodeToString(sum[:])
}

func appStoreConnectAccess(binding store.ExternalAccountBinding) string {
	return cmp.Or(binding.Access, appStoreConnectReadLevel)
}

// sessionBinding checks the session still belongs to the device owner and
// resolves the one external account its handle names.
func (g *AppStoreConnectGateway) sessionBinding(ctx context.Context, sessionID, deviceID, owner, accountID string) (store.AgentSession, appStoreConnectBinding, error) {
	session, err := g.store.GetAgentSessionSummary(ctx, sessionID)
	if err != nil || session.DeviceID != deviceID || session.CreatedByUserID != owner || gateway.SessionLive(session) != nil {
		return store.AgentSession{}, appStoreConnectBinding{}, ErrAppStoreConnectAccess
	}
	binding, err := g.bindingFor(ctx, session, deviceID, owner, accountID)
	return session, binding, err
}

func (g *AppStoreConnectGateway) bindingFor(ctx context.Context, session store.AgentSession, deviceID, owner, accountID string) (appStoreConnectBinding, error) {
	none := appStoreConnectBinding{}
	if !takesConnectors(session) {
		return none, ErrAppStoreConnectAccess
	}
	if err := store.RequireDeviceAvailable(ctx, g.store, deviceID); err != nil {
		return none, ErrAppStoreConnectAccess
	}
	deviceOwner, err := g.store.DeviceOwner(ctx, deviceID)
	if err != nil || deviceOwner != owner {
		return none, ErrAppStoreConnectAccess
	}
	policy, err := externalaccounts.ResolvePolicy(ctx, g.store, session)
	if err != nil {
		return none, err
	}
	account, err := g.store.GetExternalAccount(ctx, accountID)
	if err != nil || account.Provider != "appstoreconnect" || !externalaccounts.EligibleFor(account, account.WorkspaceIDs, session.WorkspaceID, owner, deviceOwner, policy) {
		return none, ErrAppStoreConnectAccess
	}
	workspaceIDs := []string{session.WorkspaceID}
	if policy.PersonalAgent() {
		workspaceIDs = account.WorkspaceIDs
	}
	seen := map[string]bool{}
	binding := appStoreConnectBinding{Account: account, Workspace: session.WorkspaceID, Access: appStoreConnectReadLevel}
	for _, workspaceID := range workspaceIDs {
		bindings, err := g.store.ListWorkspaceExternalAccounts(ctx, workspaceID)
		if err != nil {
			return none, err
		}
		for _, candidate := range bindings {
			if candidate.AccountID != accountID || candidate.GrantedBy != owner {
				continue
			}
			binding.Access = cmp.Or(candidate.Access, binding.Access)
			for _, appID := range candidate.ResourceIDs {
				if appID != "" && !seen[appID] {
					seen[appID] = true
					binding.AppIDs = append(binding.AppIDs, appID)
				}
			}
		}
	}
	if len(binding.AppIDs) == 0 {
		return none, &AppStoreConnectRefusal{Message: "this session has no App Store Connect apps bound to its workspace; the key owner selects apps in Connectors → this workspace → App Store Connect", Reason: gateway.ReasonNoGrant}
	}
	if !policy.Write(accountID) {
		binding.Access = appStoreConnectReadLevel
	}
	return binding, nil
}

func (g *AppStoreConnectGateway) CheckSession(ctx context.Context, sessionID, deviceID, owner, accountID string) (store.ExternalAccount, []string, error) {
	_, binding, err := g.sessionBinding(ctx, sessionID, deviceID, owner, accountID)
	if err != nil {
		return store.ExternalAccount{}, nil, err
	}
	return binding.Account, binding.AppIDs, nil
}

func (g *AppStoreConnectGateway) IssueHandles(ctx context.Context, request externalaccounts.HandleRequest) (store.ExternalAccountGateway, error) {
	if request.Account.Provider != "appstoreconnect" {
		return store.ExternalAccountGateway{}, ErrAppStoreConnectAccess
	}
	if _, _, err := g.CheckSession(ctx, request.SessionID, request.DeviceID, request.UserID, request.Account.ID); err != nil {
		return store.ExternalAccountGateway{}, err
	}
	seed := make([]byte, 32)
	if _, err := rand.Read(seed); err != nil {
		return store.ExternalAccountGateway{}, err
	}
	handle := appStoreConnectHandlePrefix + base64.RawURLEncoding.EncodeToString(seed)
	if err := g.store.CreateFeishuGatewayGrant(ctx, store.FeishuGatewayGrant{
		SessionID: request.SessionID, AccountID: request.Account.ID, AppID: request.Account.AppID, DeviceID: request.DeviceID,
		WorkspaceID: request.WorkspaceID, UserID: request.UserID,
		UserHash: appStoreConnectHash(handle), AppHash: appStoreConnectHash(handle + ":unused-app"), TenantHash: appStoreConnectHash(handle + ":unused-tenant"),
	}); err != nil {
		return store.ExternalAccountGateway{}, err
	}
	return store.ExternalAccountGateway{
		Path: AppStoreConnectGatewayPath, UserHandle: handle,
		ExpiresAt: g.Now().Add(AppStoreConnectHandleLifetime).UTC().Format(time.RFC3339),
	}, nil
}

func (g *AppStoreConnectGateway) Holdings(ctx context.Context, lease *gateway.Lease) (gateway.Holdings, *gateway.Denial) {
	binding, err := g.bindingFor(ctx, lease.Session, lease.Grant.DeviceID, lease.Device.OwnerUserID, lease.Account.ID)
	if err != nil {
		return gateway.Holdings{}, appStoreDenial(err)
	}
	return gateway.Holdings{Level: binding.Access, Resources: binding.AppIDs}, nil
}

func (g *AppStoreConnectGateway) Enter(r *http.Request) gateway.Entry {
	entry := gateway.Entry{Handle: gateway.Bearer(r), Kinds: g.pipeline.Scheme.Bearer}
	if r.Method == http.MethodGet || r.Body == nil || r.Body == http.NoBody {
		return entry
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxAppStoreConnectBody+1))
	_ = r.Body.Close()
	r.Body = io.NopCloser(bytes.NewReader(raw))
	if err != nil || len(raw) > maxAppStoreConnectBody {
		entry.Denial = &gateway.Denial{Reason: gateway.ReasonBadRequest, Message: "the body is larger than 256 KiB"}
	}
	return entry
}

func (g *AppStoreConnectGateway) Classify(r *http.Request, lease *gateway.Lease) (gateway.Need, *gateway.Denial) {
	call, denial := parseAppStoreConnectCall(r)
	need := gateway.Need{Payload: call, Detail: &AppStoreConnectAuditDetail{
		WorkspaceID: lease.Session.WorkspaceID, Method: call.Method, Path: appStoreConnectAuditPath(call.Path), Outcome: "refused",
	}}
	if denial != nil {
		return need, denial
	}
	if err := g.accounts.Integrations.Err(); err != nil {
		return need, &gateway.Denial{Reason: gateway.ReasonUnavailable, Message: err.Error(), Err: err}
	}
	raw, _ := io.ReadAll(io.LimitReader(r.Body, maxAppStoreConnectBody))
	_ = r.Body.Close()
	r.Body = io.NopCloser(bytes.NewReader(raw))
	call.Body = raw
	if call.Method != http.MethodGet {
		if call.TopType == "subscriptionPrices" {
			return need, &gateway.Denial{Reason: gateway.ReasonPathNotAllowed, Message: "App Store Connect price changes are not available to sessions; the person changes prices in App Store Connect"}
		}
		if !appStoreConnectWritable[call.TopType] {
			return need, &gateway.Denial{Reason: gateway.ReasonPathNotAllowed, Message: call.Method + " /v1/" + call.TopType + " is outside what a session may change through Foundry"}
		}
	}
	appID := call.AppID
	if appID == "" && call.ResourceID != "" {
		resolved, err := g.appForResource(r.Context(), lease, call.TopType, call.ResourceID, 0)
		if err != nil {
			return need, &gateway.Denial{Reason: gateway.ReasonPathNotAllowed, Message: "Foundry could not establish which App this request belongs to; the request was not sent", Err: err}
		}
		appID = resolved
	}
	if call.Method != http.MethodGet {
		bodyApp, bodyErr := g.appForWriteBody(r.Context(), lease, raw)
		if bodyErr != nil {
			return need, &gateway.Denial{Reason: gateway.ReasonBadRequest, Message: bodyErr.Error()}
		}
		if appID == "" {
			appID = bodyApp
		} else if bodyApp != "" && bodyApp != appID {
			return need, &gateway.Denial{Reason: gateway.ReasonPathNotAllowed, Message: "the request path and body name different Apps; the request was not sent"}
		}
	}
	if appID == "" {
		return need, &gateway.Denial{Reason: gateway.ReasonPathNotAllowed, Message: "this App Store Connect request does not map to a bound App; use /v1/apps/{id}/…, a resource id, or a relationship in the JSON body"}
	}
	call.AppID = appID
	need.Resource = appID
	if call.Method == http.MethodGet {
		need.Level = appStoreConnectReadLevel
	} else {
		need.Level = appStoreConnectCommerceLevel
		need.Write = true
		need.Risk = "appstoreconnect_change"
		need.RiskSummary = "The assistant wants to change App Store Connect (" + call.Method + " " + appStoreConnectAuditPath(call.Path) + ")."
	}
	return need, nil
}

func parseAppStoreConnectCall(r *http.Request) (*appStoreConnectCall, *gateway.Denial) {
	method := strings.ToUpper(r.Method)
	if method != http.MethodGet && method != http.MethodPost && method != http.MethodPatch {
		return &appStoreConnectCall{Method: method, Path: "/"}, &gateway.Denial{Reason: gateway.ReasonBadRequest, Message: "App Store Connect sessions use GET, POST or PATCH"}
	}
	path := strings.TrimPrefix(r.URL.Path, AppStoreConnectGatewayPath)
	path = "/" + strings.TrimPrefix(path, "/")
	call := &appStoreConnectCall{Method: method, Path: path, Query: r.URL.Query()}
	if strings.ContainsAny(path, "\\%?#\x00\r\n") || strings.Contains(path, "..") || !strings.HasPrefix(path, "/v1/") {
		return call, &gateway.Denial{Reason: gateway.ReasonPathNotAllowed, Message: "the path is not an App Store Connect API v1 resource"}
	}
	if len(call.Query) > 20 {
		return call, &gateway.Denial{Reason: gateway.ReasonQueryNotAllow, Message: "too many query parameters"}
	}
	for key, values := range call.Query {
		if len(key) > 80 || len(values) != 1 || len(values[0]) > 512 {
			return call, &gateway.Denial{Reason: gateway.ReasonQueryNotAllow, Message: "each query parameter takes one value of at most 512 characters"}
		}
	}
	parts := strings.Split(strings.TrimPrefix(path, "/v1/"), "/")
	call.TopType = parts[0]
	if _, ok := appStoreConnectKnownTypes[call.TopType]; !ok {
		return call, &gateway.Denial{Reason: gateway.ReasonPathNotAllowed, Message: "this App Store Connect resource is not available through Foundry"}
	}
	if len(parts) >= 2 {
		if parts[1] == "" || len(parts[1]) > 80 {
			return call, &gateway.Denial{Reason: gateway.ReasonPathNotAllowed, Message: "the App Store Connect resource id is invalid"}
		}
		call.ResourceID = parts[1]
	}
	if len(parts) > 2 && !appStoreConnectNestedAllowed(call.TopType, parts[2:], method) {
		return call, &gateway.Denial{Reason: gateway.ReasonPathNotAllowed, Message: "this nested App Store Connect path is not available through Foundry"}
	}
	if method != http.MethodGet && call.TopType == "subscriptions" && len(parts) >= 4 && parts[2] == "relationships" && (parts[3] == "prices" || parts[3] == "subscriptionPrices") {
		return call, &gateway.Denial{Reason: gateway.ReasonPathNotAllowed, Message: "App Store Connect price changes are not available to sessions; the person changes prices in App Store Connect"}
	}
	if call.TopType == "apps" && call.ResourceID == "" {
		return call, &gateway.Denial{Reason: gateway.ReasonPathNotAllowed, Message: "list only a bound App; account-wide /v1/apps is not available to sessions"}
	}
	if call.TopType == "apps" {
		if method != http.MethodGet || len(parts) != 2 {
			return call, &gateway.Denial{Reason: gateway.ReasonPathNotAllowed, Message: "the Apps resource is read-only, and only by a bound app id"}
		}
		call.AppID = call.ResourceID
	}
	if method == http.MethodGet && call.ResourceID == "" {
		return call, &gateway.Denial{Reason: gateway.ReasonPathNotAllowed, Message: "account-wide App Store Connect collections are not available to sessions"}
	}
	return call, nil
}

var appStoreConnectKnownTypes = map[string]bool{
	"apps": true, "subscriptionGroups": true, "subscriptions": true,
	"subscriptionPrices": true, "subscriptionIntroductoryOffers": true,
	"subscriptionLocalizations": true, "subscriptionGroupLocalizations": true,
	"subscriptionAppStoreReviewScreenshots": true,
}

var appStoreConnectWritable = map[string]bool{
	"subscriptionGroups": true, "subscriptions": true,
	"subscriptionIntroductoryOffers": true, "subscriptionLocalizations": true,
	"subscriptionGroupLocalizations": true, "subscriptionAppStoreReviewScreenshots": true,
}

var appStoreConnectNested = map[string]map[string]bool{
	"apps":               {"subscriptionGroups": true, "subscriptions": true},
	"subscriptionGroups": {"subscriptions": true, "subscriptionGroupLocalizations": true, "relationships": true},
	"subscriptions":      {"subscriptionPrices": true, "subscriptionIntroductoryOffers": true, "subscriptionLocalizations": true, "subscriptionAppStoreReviewScreenshots": true, "relationships": true},
}

func appStoreConnectNestedAllowed(topType string, tail []string, method string) bool {
	if len(tail) == 0 {
		return true
	}
	allowed := appStoreConnectNested[topType]
	if len(tail) > 0 && tail[0] == "relationships" {
		if len(tail) < 2 || len(tail) > 3 {
			return false
		}
		return method == http.MethodGet || (method == http.MethodPost && len(tail) == 2)
	}
	if !allowed[tail[0]] {
		return false
	}
	return len(tail) == 1 || (len(tail) == 3 && tail[1] == "relationships")
}

type appStoreConnectRelation struct {
	ParentType  string
	Relation    string
	RelatedType string
}

var appStoreConnectParents = map[string]appStoreConnectRelation{
	"subscriptionGroups":                    {ParentType: "apps", Relation: "app", RelatedType: "apps"},
	"subscriptions":                         {ParentType: "subscriptionGroups", Relation: "subscriptionGroup", RelatedType: "subscriptionGroups"},
	"subscriptionPrices":                    {ParentType: "subscriptions", Relation: "subscription", RelatedType: "subscriptions"},
	"subscriptionIntroductoryOffers":        {ParentType: "subscriptions", Relation: "subscription", RelatedType: "subscriptions"},
	"subscriptionLocalizations":             {ParentType: "subscriptions", Relation: "subscription", RelatedType: "subscriptions"},
	"subscriptionGroupLocalizations":        {ParentType: "subscriptionGroups", Relation: "subscriptionGroup", RelatedType: "subscriptionGroups"},
	"subscriptionAppStoreReviewScreenshots": {ParentType: "subscriptions", Relation: "subscription", RelatedType: "subscriptions"},
}

func (g *AppStoreConnectGateway) appForResource(ctx context.Context, lease *gateway.Lease, resourceType, id string, depth int) (string, error) {
	if depth > 4 {
		return "", errors.New("the App Store Connect relationship chain is too deep")
	}
	if resourceType == "apps" {
		return id, nil
	}
	key := resourceType + ":" + id
	g.lookupMu.Lock()
	entry, ok := g.lookups[key]
	g.lookupMu.Unlock()
	if ok && entry.Expires.After(g.Now()) {
		return entry.AppID, nil
	}
	parent := appStoreConnectParents[resourceType]
	if parent.ParentType == "" {
		return "", errors.New("the resource has no App relationship")
	}
	parentID, err := g.relationshipID(ctx, lease, resourceType, id, parent.Relation)
	if err != nil {
		return "", err
	}
	appID, err := g.appForResource(ctx, lease, parent.ParentType, parentID, depth+1)
	if err != nil {
		return "", err
	}
	g.lookupMu.Lock()
	if len(g.lookups) > 4096 {
		g.lookups = map[string]appStoreConnectLookup{}
	}
	g.lookups[key] = appStoreConnectLookup{AppID: appID, Expires: g.Now().Add(appStoreConnectLookupTTL)}
	g.lookupMu.Unlock()
	return appID, nil
}

func (g *AppStoreConnectGateway) relationshipID(ctx context.Context, lease *gateway.Lease, resourceType, id, relation string) (string, error) {
	response, err := g.accounts.DoAppStoreConnect(ctx, lease.App, http.MethodGet, "/v1/"+resourceType+"/"+url.PathEscape(id), nil, nil, nil)
	if err != nil {
		return "", err
	}
	payload, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	response.Body.Close()
	if readErr != nil || response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("App Store Connect resource read answered HTTP %d", response.StatusCode)
	}
	if related := appStoreConnectRelationshipValue(payload, relation); related != "" {
		return related, nil
	}
	// Some JSON:API responses omit relationship data unless it is requested.
	response, err = g.accounts.DoAppStoreConnect(ctx, lease.App, http.MethodGet, "/v1/"+resourceType+"/"+url.PathEscape(id)+"/"+url.PathEscape(relation), nil, nil, nil)
	if err != nil {
		return "", err
	}
	payload, readErr = io.ReadAll(io.LimitReader(response.Body, 1<<20))
	response.Body.Close()
	if readErr != nil || response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("App Store Connect relationship read answered HTTP %d", response.StatusCode)
	}
	if related := appStoreConnectRelationshipValue(payload, ""); related != "" {
		return related, nil
	}
	return "", errors.New("the resource names no parent App relationship")
}

func appStoreConnectRelationshipValue(payload []byte, relation string) string {
	var document struct {
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal(payload, &document) != nil || len(document.Data) == 0 {
		return ""
	}
	if relation == "" {
		var item struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(document.Data, &item)
		return item.ID
	}
	var item struct {
		Relationships map[string]struct {
			Data *struct {
				ID string `json:"id"`
			} `json:"data"`
		} `json:"relationships"`
	}
	if json.Unmarshal(document.Data, &item) != nil {
		return ""
	}
	if related := item.Relationships[relation].Data; related != nil {
		return related.ID
	}
	return ""
}

func (g *AppStoreConnectGateway) appForWriteBody(ctx context.Context, lease *gateway.Lease, raw json.RawMessage) (string, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return "", nil
	}
	var document struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &document); err != nil || len(document.Data) == 0 {
		return "", errors.New("the JSON body must be one App Store Connect resource object")
	}
	items := []json.RawMessage{document.Data}
	if bytes.HasPrefix(bytes.TrimSpace(document.Data), []byte("[")) {
		items = nil
		if err := json.Unmarshal(document.Data, &items); err != nil {
			return "", errors.New("the JSON body must be one App Store Connect resource object")
		}
	}
	found := ""
	for _, item := range items {
		var resource struct {
			Relationships map[string]struct {
				Data *struct {
					Type string `json:"type"`
					ID   string `json:"id"`
				} `json:"data"`
			} `json:"relationships"`
		}
		if err := json.Unmarshal(item, &resource); err != nil {
			return "", errors.New("the JSON body must be one App Store Connect resource object")
		}
		for name, relationship := range resource.Relationships {
			if relationship.Data == nil || relationship.Data.ID == "" {
				continue
			}
			resourceType := relationship.Data.Type
			switch name {
			case "app":
				resourceType = "apps"
			case "subscriptionGroup":
				resourceType = "subscriptionGroups"
			case "subscription":
				resourceType = "subscriptions"
			default:
				continue
			}
			appID, err := g.appForResource(ctx, lease, resourceType, relationship.Data.ID, 0)
			if err != nil {
				return "", err
			}
			if found != "" && found != appID {
				return "", errors.New("the body relationships name different Apps")
			}
			found = appID
		}
	}
	return found, nil
}

func (g *AppStoreConnectGateway) Refuse(w http.ResponseWriter, r *http.Request, denial *gateway.Denial) gateway.Refused {
	status := http.StatusForbidden
	refusal := &AppStoreConnectRefusal{
		Reason: denial.Reason, Needed: denial.Needed, Current: denial.Current,
		Message: denial.Message,
	}
	switch denial.Reason {
	case gateway.ReasonNoCredential, gateway.ReasonAccessEnded, gateway.ReasonHandleExpired:
		status = http.StatusUnauthorized
		if denial.Reason == gateway.ReasonHandleExpired {
			refusal.Message = ErrAppStoreConnectHandleExpired.Error()
		} else {
			refusal.Message = ErrAppStoreConnectAccess.Error()
		}
	case gateway.ReasonNotBound:
		refusal.Message = "that App is not bound to this workspace; the key owner selects apps in Connectors → this workspace → App Store Connect"
	case gateway.ReasonAccessLevel:
		refusal.Message = fmt.Sprintf("%s %s needs the %s access level; this binding has %s", r.Method, appStoreConnectAuditPath(r.URL.Path), denial.Needed, denial.Current)
	case gateway.ReasonConnectorOff:
		refusal.Message = "the person did not give the assistant access to this App Store Connect key; they change that in Assistant settings → Connectors"
	case gateway.ReasonConnectorRead:
		refusal.Message = "the assistant has read-only access to this App Store Connect key; this change needs write access in Assistant settings → Connectors"
	case gateway.ReasonNeedsConfirmation:
		refusal.Message = denial.Summary + " Accept proposal " + denial.ProposalID + " before repeating this exact request."
	case gateway.ReasonRateLimited:
		status = http.StatusTooManyRequests
		w.Header().Set("Retry-After", strconv.Itoa(int(denial.Wait/time.Second)+1))
		refusal.Message = "too many App Store Connect calls from this session; slow down"
	case gateway.ReasonBadRequest:
		status = http.StatusBadRequest
	case gateway.ReasonUnavailable:
		status = http.StatusServiceUnavailable
	case gateway.ReasonInternal:
		status = http.StatusInternalServerError
		g.pipeline.Logf("app store connect gateway: %v", denial.Err)
		refusal.Message = "Foundry could not check this App Store Connect request"
	}
	if refusal.Message == "" {
		refusal.Message = "Foundry refused this App Store Connect request"
	}
	return writeAppStoreConnectError(w, status, refusal)
}

func (g *AppStoreConnectGateway) Upstream(w http.ResponseWriter, r *http.Request, x *gateway.Exchange) *gateway.Denial {
	call := x.Need.Payload.(*appStoreConnectCall)
	headers := make(http.Header)
	for _, name := range []string{"Content-Type", "If-None-Match", "If-Modified-Since"} {
		if value := r.Header.Get(name); value != "" {
			headers.Set(name, value)
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	response, err := g.accounts.DoAppStoreConnect(ctx, x.Lease.App, call.Method, call.Path, call.Query, headers, r.Body)
	if err != nil {
		status := http.StatusBadGateway
		message := "App Store Connect could not be reached"
		if errors.Is(err, externalaccounts.ErrAppStoreConnectKeyRevoked) {
			status, message = http.StatusUnauthorized, "this session's App Store Connect key was revoked; ask its owner to add or replace the key"
		}
		x.Outcome, x.Status = gateway.OutcomeUpstreamError, status
		writeAppStoreConnectError(w, status, &AppStoreConnectRefusal{Reason: gateway.ReasonUnavailable, Message: message})
		return nil
	}
	defer response.Body.Close()
	for name, values := range response.Header {
		switch http.CanonicalHeaderKey(name) {
		case "Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade":
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
	_, _ = io.Copy(w, response.Body)
	return nil
}

type AppStoreConnectRefusal struct {
	Message string
	Reason  string
	Needed  string
	Current string
}

func (e *AppStoreConnectRefusal) Error() string { return e.Message }

func appStoreDenial(err error) *gateway.Denial {
	var refusal *AppStoreConnectRefusal
	if errors.As(err, &refusal) {
		return &gateway.Denial{Reason: refusal.Reason, Message: refusal.Message, Needed: refusal.Needed, Current: refusal.Current}
	}
	if errors.Is(err, ErrAppStoreConnectAccess) {
		return &gateway.Denial{Reason: gateway.ReasonAccessEnded}
	}
	return &gateway.Denial{Reason: gateway.ReasonInternal, Err: err}
}

func writeAppStoreConnectError(w http.ResponseWriter, status int, refusal *AppStoreConnectRefusal) gateway.Refused {
	code := strings.ToUpper(strings.ReplaceAll(cmp.Or(refusal.Reason, "refused"), "-", "_"))
	body := map[string]any{
		"errors": []any{map[string]any{
			"id": "foundry-" + strconv.Itoa(status), "status": strconv.Itoa(status),
			"code": "FOUNDRY_" + code, "title": "Foundry refused this App Store Connect request",
			"detail": refusal.Message,
		}},
		"foundry": map[string]any{
			"refused": true, "reason": cmp.Or(refusal.Reason, gateway.ReasonBlocked),
			"needed": refusal.Needed, "current": refusal.Current,
		},
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
	return gateway.Refused{Status: status, Message: refusal.Message}
}

func appStoreConnectAuditPath(path string) string {
	path = strings.TrimPrefix(path, AppStoreConnectGatewayPath)
	path = "/" + strings.TrimPrefix(path, "/")
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(parts) >= 3 && parts[0] == "v1" {
		parts[2] = ":id"
	}
	return "/" + strings.Join(parts, "/")
}

type appStoreConnectAudit struct{ g *AppStoreConnectGateway }

func (a appStoreConnectAudit) Record(ctx context.Context, record gateway.Record) {
	grant := record.Grant
	if record.Lease != nil {
		grant = &record.Lease.Grant
	}
	if grant == nil {
		return
	}
	call, _ := record.Need.Payload.(*appStoreConnectCall)
	detail := &AppStoreConnectAuditDetail{
		WorkspaceID: grant.WorkspaceID,
		Method:      record.Request.Method,
		Path:        appStoreConnectAuditPath(record.Request.URL.Path),
		Status:      record.Status,
		Outcome:     record.Outcome,
	}
	if call != nil {
		detail.AppID = call.AppID
	}
	if record.Denial != nil {
		detail.Outcome = record.Outcome
		detail.Error = shortError(errors.New(record.Message))
	}
	line, _ := json.Marshal(detail)
	event := store.ExternalAccountEvent{
		AccountID: grant.AccountID, Kind: "appstoreconnect_request",
		SessionID: grant.SessionID, DeviceID: grant.DeviceID,
		ActorID: record.Device.OwnerUserID, Detail: string(line),
	}
	audit, done := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer done()
	_ = a.g.store.AppendExternalAccountEvent(audit, event)
}
