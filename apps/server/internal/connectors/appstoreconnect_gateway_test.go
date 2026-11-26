package connectors

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type appStoreConnectUpstreamCall struct {
	Method        string
	Path          string
	Authorization string
	DeviceHeader  string
}

type appStoreConnectFixture struct {
	st       *sqlitestore.Store
	gateway  *AppStoreConnectGateway
	session  store.AgentSession
	account  store.ExternalAccount
	handle   string
	boundApp string
	mu       sync.Mutex
	calls    []appStoreConnectUpstreamCall
}

func newAppStoreConnectFixture(t *testing.T) *appStoreConnectFixture {
	t.Helper()
	ctx := context.Background()
	st, err := sqlitestore.OpenWithOptions(filepath.Join(t.TempDir(), "db"), sqlitestore.Options{SecretKeyPath: filepath.Join(t.TempDir(), "key")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	f := &appStoreConnectFixture{st: st, boundApp: "123456789"}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.calls = append(f.calls, appStoreConnectUpstreamCall{
			Method: r.Method, Path: r.URL.Path, Authorization: r.Header.Get("Authorization"),
			DeviceHeader: r.Header.Get("X-Foundry-Device-Credential"),
		})
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		reply := func(data any) {
			_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
		}
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/apps" && r.URL.Query().Get("limit") == "1":
			reply([]any{})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/apps/"+f.boundApp+"/subscriptionGroups":
			reply([]any{map[string]any{"id": "group-1", "type": "subscriptionGroups"}})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/apps/"+f.boundApp:
			reply(map[string]any{"id": f.boundApp, "type": "apps", "attributes": map[string]any{"name": "Fixture App"}})
		case r.Method == http.MethodGet && (r.URL.Path == "/v1/subscriptionGroups/group-1" || r.URL.Path == "/v1/subscriptionGroups/group-other"):
			reply(map[string]any{"id": strings.TrimPrefix(r.URL.Path, "/v1/subscriptionGroups/"), "type": "subscriptionGroups"})
		case r.Method == http.MethodGet && (r.URL.Path == "/v1/subscriptions/sub-1" || r.URL.Path == "/v1/subscriptions/sub-other"):
			group := map[string]string{"sub-1": "group-1", "sub-other": "group-other"}[strings.TrimPrefix(r.URL.Path, "/v1/subscriptions/")]
			reply(appStoreConnectFakeResource(r, "subscriptions", strings.TrimPrefix(r.URL.Path, "/v1/subscriptions/"), "group", "subscriptionGroups", group))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscriptionPrices/price-1":
			reply(map[string]any{"id": "price-1", "type": "subscriptionPrices", "relationships": map[string]any{
				"subscription": map[string]any{"data": map[string]any{"id": "sub-1", "type": "subscriptions"}},
			}})
		case r.Method == http.MethodGet && appStoreConnectStorePageParents[strings.TrimPrefix(r.URL.Path, "/v1/")] != nil:
			path := strings.TrimPrefix(r.URL.Path, "/v1/")
			parent := appStoreConnectStorePageParents[path]
			parentID := parent[2]
			if parentID == "bound" {
				parentID = f.boundApp
			}
			parts := strings.SplitN(path, "/", 2)
			reply(appStoreConnectFakeResource(r, parts[0], parts[1], parent[0], parent[1], parentID))
		case strings.HasPrefix(r.URL.Path, "/v1/"):
			reply(map[string]any{"id": strings.TrimPrefix(r.URL.Path, "/v1/"), "type": "fixture"})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(upstream.Close)
	provider := externalaccounts.NewAppStoreConnect()
	provider.BaseURL = upstream.URL
	provider.Client = upstream.Client()
	service := externalaccounts.NewService(st, st, externalaccounts.NewRegistry(provider))
	privateKey := appStoreConnectGatewayKey(t)
	connection, err := service.CreateAppStoreConnectKey(ctx, "alice", store.SaveAppStoreConnectKeyInput{
		IssuerID: "11111111-2222-3333-4444-555555555555", KeyID: "ABCDEF1234",
		PrivateKey: privateKey, Label: "Fixture App Store Connect",
	})
	if err != nil {
		t.Fatal(err)
	}
	f.account, err = st.GetExternalAccount(ctx, connection.AccountID)
	if err != nil {
		t.Fatal(err)
	}
	f.session = store.AgentSession{ID: "session-alice", DeviceID: "device-alice", WorkspaceID: "workspace-a", CreatedByUserID: "alice", Status: "running"}
	f.gateway = NewAppStoreConnectGateway(&cfGatewayStore{Store: st, session: f.session}, service)
	if err := st.SetWorkspaceExternalAccounts(ctx, "workspace-a", "alice", []string{f.account.ID}, map[string][]string{f.account.ID: {f.boundApp}}); err != nil {
		t.Fatal(err)
	}
	issued, err := f.gateway.IssueHandles(ctx, externalaccounts.HandleRequest{
		SessionID: f.session.ID, DeviceID: f.session.DeviceID, WorkspaceID: f.session.WorkspaceID,
		UserID: "alice", Account: f.account,
	})
	if err != nil {
		t.Fatal(err)
	}
	f.handle = issued.UserHandle
	return f
}

func appStoreConnectGatewayKey(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
}

func callAppStoreConnectGateway(f *appStoreConnectFixture, deviceID, owner, method, path string, query url.Values, body json.RawMessage) (int, []byte) {
	target := AppStoreConnectGatewayPath + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	request := httptest.NewRequest(method, target, bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+f.handle)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Foundry-Device-Credential", "must-not-reach-apple")
	recorder := httptest.NewRecorder()
	f.gateway.Serve(recorder, request, gateway.Device{ID: deviceID, OwnerUserID: owner})
	return recorder.Code, recorder.Body.Bytes()
}

func appStoreConnectDenialReason(t *testing.T, body []byte) string {
	t.Helper()
	var answer struct {
		Foundry struct {
			Reason string `json:"reason"`
		} `json:"foundry"`
	}
	if err := json.Unmarshal(body, &answer); err != nil {
		t.Fatalf("unreadable refusal %s: %v", body, err)
	}
	return answer.Foundry.Reason
}

func TestAppStoreConnectGatewayMapsResourcesAndBlocksMoneyWrites(t *testing.T) {
	ctx := context.Background()
	f := newAppStoreConnectFixture(t)
	if !strings.HasPrefix(f.handle, "fdyasc_user_") {
		t.Fatal("session did not receive an App Store Connect stand-in")
	}
	for _, path := range []string{"/v1/apps/" + f.boundApp, "/v1/apps/" + f.boundApp + "/subscriptionGroups", "/v1/subscriptions/sub-1", "/v1/subscriptions/sub-1", "/v1/subscriptionPrices/price-1"} {
		status, body := callAppStoreConnectGateway(f, "device-alice", "alice", http.MethodGet, path, nil, nil)
		if status != http.StatusOK {
			t.Fatalf("GET %s: %d %s", path, status, body)
		}
	}
	createGroup := json.RawMessage(`{"data":{"type":"subscriptionGroups","attributes":{"referenceName":"Fixture"},"relationships":{"app":{"data":{"type":"apps","id":"` + f.boundApp + `"}}}}}`)
	status, body := callAppStoreConnectGateway(f, "device-alice", "alice", http.MethodPost, "/v1/subscriptionGroups", nil, createGroup)
	if status != http.StatusForbidden || appStoreConnectDenialReason(t, body) != gateway.ReasonAccessLevel {
		t.Fatalf("read binding wrote commerce: %d %s", status, body)
	}
	if err := f.st.SetExternalAccountBindingAccess(ctx, "workspace-a", f.account.ID, "alice", "commerce"); err != nil {
		t.Fatal(err)
	}
	status, body = callAppStoreConnectGateway(f, "device-alice", "alice", http.MethodPost, "/v1/subscriptionGroups", nil, createGroup)
	if status != http.StatusOK {
		t.Fatalf("commerce write: %d %s", status, body)
	}
	status, body = callAppStoreConnectGateway(f, "device-alice", "alice", http.MethodPatch, "/v1/subscriptions/sub-1", nil,
		json.RawMessage(`{"data":{"type":"subscriptions","id":"sub-1","attributes":{"name":"Renamed"}}}`))
	if status != http.StatusOK {
		t.Fatalf("subscription patch: %d %s", status, body)
	}
	for _, tc := range []struct {
		method, path, reason string
		body                 json.RawMessage
	}{
		{http.MethodGet, "/v1/apps", gateway.ReasonPathNotAllowed, nil},
		{http.MethodGet, "/v1/apps/987654321", gateway.ReasonNotBound, nil},
		{http.MethodGet, "/v1/apps/987654321/subscriptionGroups", gateway.ReasonNotBound, nil},
		{http.MethodGet, "/v1/apps/" + f.boundApp + "/customerReviews", gateway.ReasonPathNotAllowed, nil},
		{http.MethodPost, "/v1/apps/" + f.boundApp + "/subscriptionGroups", gateway.ReasonPathNotAllowed, json.RawMessage(`{"data":{"type":"subscriptionGroups"}}`)},
		{http.MethodGet, "/v1/subscriptions/sub-other", gateway.ReasonNotBound, nil},
		{http.MethodGet, "/v1/customers", gateway.ReasonPathNotAllowed, nil},
		{http.MethodPatch, "/v1/subscriptionPrices/price-1", gateway.ReasonPathNotAllowed, json.RawMessage(`{"data":{"type":"subscriptionPrices","id":"price-1"}}`)},
		{http.MethodPost, "/v1/subscriptions/sub-1/relationships/subscriptionPrices", gateway.ReasonPathNotAllowed, json.RawMessage(`{"data":[{"type":"subscriptionPrices","id":"price-1"}]}`)},
	} {
		status, body := callAppStoreConnectGateway(f, "device-alice", "alice", tc.method, tc.path, nil, tc.body)
		if status != http.StatusForbidden || appStoreConnectDenialReason(t, body) != tc.reason {
			t.Fatalf("%s %s: %d %s", tc.method, tc.path, status, body)
		}
	}
	if status, body := callAppStoreConnectGateway(f, "device-other", "alice", http.MethodGet, "/v1/apps/"+f.boundApp, nil, nil); status != http.StatusUnauthorized {
		t.Fatalf("another device used the handle: %d %s", status, body)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	writes := 0
	groupLookups := 0
	for _, call := range f.calls {
		if call.Authorization == "" || call.Authorization == "Bearer "+f.handle || strings.HasPrefix(call.Authorization, "Bearer fdyasc_") {
			t.Fatalf("stand-in or missing JWT reached Apple: %+v", call)
		}
		if call.DeviceHeader != "" {
			t.Fatalf("device credential reached Apple: %+v", call)
		}
		if call.Method == http.MethodPost || call.Method == http.MethodPatch {
			writes++
		}
		if call.Method == http.MethodGet && call.Path == "/v1/apps/"+f.boundApp+"/subscriptionGroups" {
			groupLookups++
		}
		if call.Path == "/v1/subscriptionPrices/price-1" && call.Method != http.MethodGet {
			t.Fatalf("price mutation reached Apple: %+v", call)
		}
	}
	if writes != 2 {
		t.Fatalf("writes reached Apple: %+v", f.calls)
	}
	// The session's own listing, then one lookup each for group-1 (cached
	// afterwards) and group-other (outside the bound App).
	if groupLookups != 3 {
		t.Fatalf("relationship lookup cache missed: %d listings", groupLookups)
	}
	events, err := f.st.ListExternalAccountEvents(ctx, f.account.ID, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) == 0 {
		t.Fatal("gateway wrote no audit lines")
	}
	for _, event := range events {
		if strings.Contains(event.Detail, f.handle) || strings.Contains(event.Detail, "Bearer ") || strings.Contains(event.Detail, "Renamed") {
			t.Fatalf("audit leaked a credential or request body: %+v", event)
		}
	}
}

// appStoreConnectStorePageParents is the fake store page tree: resource path
// to its owning relationship, the related type and id ("bound" is the bound
// App).
var appStoreConnectStorePageParents = map[string]*[3]string{
	"builds/build-1":                     {"app", "apps", "bound"},
	"appInfos/info-1":                    {"app", "apps", "bound"},
	"appInfoLocalizations/info-loc-1":    {"appInfo", "appInfos", "info-1"},
	"appStoreVersions/ver-1":             {"app", "apps", "bound"},
	"appStoreVersions/ver-other":         {"app", "apps", "987654321"},
	"appStoreVersionLocalizations/loc-1": {"appStoreVersion", "appStoreVersions", "ver-1"},
	"appStoreVersionLocalizations/loc-x": {"appStoreVersion", "appStoreVersions", "ver-other"},
	"appScreenshotSets/set-1":            {"appStoreVersionLocalization", "appStoreVersionLocalizations", "loc-1"},
	"appScreenshots/shot-1":              {"appScreenshotSet", "appScreenshotSets", "set-1"},
}

func TestAppStoreConnectGatewayStorePageLevel(t *testing.T) {
	ctx := context.Background()
	f := newAppStoreConnectFixture(t)
	call := func(method, path string, body string) (int, []byte) {
		var raw json.RawMessage
		if body != "" {
			raw = json.RawMessage(body)
		}
		return callAppStoreConnectGateway(f, "device-alice", "alice", method, path, nil, raw)
	}
	for _, path := range []string{
		"/v1/apps/" + f.boundApp + "/appInfos", "/v1/apps/" + f.boundApp + "/appStoreVersions",
		"/v1/appInfos/info-1/appInfoLocalizations", "/v1/appStoreVersions/ver-1/appStoreVersionLocalizations",
		"/v1/appStoreVersionLocalizations/loc-1/appScreenshotSets", "/v1/appScreenshotSets/set-1/appScreenshots",
	} {
		if status, body := call(http.MethodGet, path, ""); status != http.StatusOK {
			t.Fatalf("read binding GET %s: %d %s", path, status, body)
		}
	}
	patchLocalization := `{"data":{"type":"appStoreVersionLocalizations","id":"loc-1","attributes":{"description":"Snap a receipt"}}}`
	if status, body := call(http.MethodPatch, "/v1/appStoreVersionLocalizations/loc-1", patchLocalization); status != http.StatusForbidden || appStoreConnectDenialReason(t, body) != gateway.ReasonAccessLevel {
		t.Fatalf("read binding edited the store page: %d %s", status, body)
	}
	if err := f.st.SetExternalAccountBindingAccess(ctx, "workspace-a", f.account.ID, "alice", "listing"); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodPatch, "/v1/appStoreVersionLocalizations/loc-1", patchLocalization},
		{http.MethodPost, "/v1/appStoreVersionLocalizations", `{"data":{"type":"appStoreVersionLocalizations","attributes":{"locale":"zh-Hans"},"relationships":{"appStoreVersion":{"data":{"type":"appStoreVersions","id":"ver-1"}}}}}`},
		{http.MethodPost, "/v1/appInfoLocalizations", `{"data":{"type":"appInfoLocalizations","attributes":{"locale":"zh-Hans","name":"Blinklet"},"relationships":{"appInfo":{"data":{"type":"appInfos","id":"info-1"}}}}}`},
		{http.MethodPost, "/v1/appScreenshots", `{"data":{"type":"appScreenshots","attributes":{"fileName":"a.png","fileSize":10},"relationships":{"appScreenshotSet":{"data":{"type":"appScreenshotSets","id":"set-1"}}}}}`},
		{http.MethodDelete, "/v1/appScreenshots/shot-1", ""},
	} {
		if status, body := call(tc.method, tc.path, tc.body); status != http.StatusOK {
			t.Fatalf("listing binding %s %s: %d %s", tc.method, tc.path, status, body)
		}
	}
	for _, tc := range []struct{ method, path, body, reason string }{
		{http.MethodPost, "/v1/subscriptionGroups", `{"data":{"type":"subscriptionGroups","attributes":{"referenceName":"Fixture"},"relationships":{"app":{"data":{"type":"apps","id":"` + f.boundApp + `"}}}}}`, gateway.ReasonAccessLevel},
		{http.MethodPatch, "/v1/appStoreVersionLocalizations/loc-x", `{"data":{"type":"appStoreVersionLocalizations","id":"loc-x"}}`, gateway.ReasonNotBound},
		{http.MethodPost, "/v1/appStoreVersionLocalizations", `{"data":{"type":"appStoreVersionLocalizations","relationships":{"appStoreVersion":{"data":{"type":"appStoreVersions","id":"ver-other"}}}}}`, gateway.ReasonNotBound},
		{http.MethodDelete, "/v1/appStoreVersionLocalizations/loc-1", "", gateway.ReasonPathNotAllowed},
		{http.MethodDelete, "/v1/subscriptions/sub-1", "", gateway.ReasonPathNotAllowed},
		{http.MethodPatch, "/v1/apps/" + f.boundApp, `{"data":{"type":"apps","id":"` + f.boundApp + `"}}`, gateway.ReasonPathNotAllowed},
		{http.MethodPost, "/v1/appStoreVersionSubmissions", `{"data":{"type":"appStoreVersionSubmissions"}}`, gateway.ReasonPathNotAllowed},
	} {
		if status, body := call(tc.method, tc.path, tc.body); status != http.StatusForbidden || appStoreConnectDenialReason(t, body) != tc.reason {
			t.Fatalf("%s %s: %d %s (want %s)", tc.method, tc.path, status, body, tc.reason)
		}
	}
}

// appStoreConnectFakeResource answers like Apple: a relationship's data only
// when the request includes it.
func appStoreConnectFakeResource(r *http.Request, resourceType, id, relation, relatedType, relatedID string) map[string]any {
	resource := map[string]any{"id": id, "type": resourceType, "relationships": map[string]any{
		relation: map[string]any{"links": map[string]any{"self": "https://example.invalid"}},
	}}
	if r.URL.Query().Get("include") == relation {
		resource["relationships"] = map[string]any{relation: map[string]any{"data": map[string]any{"id": relatedID, "type": relatedType}}}
	}
	return resource
}

func TestAppStoreConnectGatewayAvailabilityTerritoriesAndNotificationURLs(t *testing.T) {
	ctx := context.Background()
	f := newAppStoreConnectFixture(t)
	call := func(method, path, body string) (int, []byte) {
		var raw json.RawMessage
		if body != "" {
			raw = json.RawMessage(body)
		}
		return callAppStoreConnectGateway(f, "device-alice", "alice", method, path, nil, raw)
	}
	availability := `{"data":{"type":"subscriptionAvailabilities","attributes":{"availableInNewTerritories":true},"relationships":{"subscription":{"data":{"type":"subscriptions","id":"sub-1"}},"availableTerritories":{"data":[{"type":"territories","id":"USA"}]}}}}`
	notify := `{"data":{"type":"apps","id":"` + f.boundApp + `","attributes":{"subscriptionStatusUrl":"https://api.example.invalid/n","subscriptionStatusUrlVersion":"V2"}}}`
	for _, path := range []string{"/v1/territories", "/v1/subscriptions/sub-1/subscriptionAvailability"} {
		if status, body := call(http.MethodGet, path, ""); status != http.StatusOK {
			t.Fatalf("read binding GET %s: %d %s", path, status, body)
		}
	}
	if err := f.st.SetExternalAccountBindingAccess(ctx, "workspace-a", f.account.ID, "alice", "listing"); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodPost, "/v1/subscriptionAvailabilities", availability},
		{http.MethodPatch, "/v1/apps/" + f.boundApp, notify},
	} {
		if status, body := call(tc.method, tc.path, tc.body); status != http.StatusForbidden || appStoreConnectDenialReason(t, body) != gateway.ReasonAccessLevel {
			t.Fatalf("listing binding %s %s: %d %s", tc.method, tc.path, status, body)
		}
	}
	if err := f.st.SetExternalAccountBindingAccess(ctx, "workspace-a", f.account.ID, "alice", "commerce"); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodPost, "/v1/subscriptionAvailabilities", availability},
		{http.MethodPatch, "/v1/apps/" + f.boundApp, notify},
	} {
		if status, body := call(tc.method, tc.path, tc.body); status != http.StatusOK {
			t.Fatalf("commerce binding %s %s: %d %s", tc.method, tc.path, status, body)
		}
	}
	for _, tc := range []struct{ method, path, body, reason string }{
		{http.MethodPatch, "/v1/apps/" + f.boundApp, `{"data":{"type":"apps","id":"` + f.boundApp + `","attributes":{"primaryLocale":"zh-Hans"}}}`, gateway.ReasonPathNotAllowed},
		{http.MethodPatch, "/v1/apps/987654321", `{"data":{"type":"apps","id":"987654321","attributes":{"subscriptionStatusUrl":"https://x.invalid"}}}`, gateway.ReasonNotBound},
		{http.MethodPost, "/v1/territories", `{"data":{"type":"territories"}}`, gateway.ReasonPathNotAllowed},
		{http.MethodPost, "/v1/subscriptionAvailabilities", `{"data":{"type":"subscriptionAvailabilities","relationships":{"subscription":{"data":{"type":"subscriptions","id":"sub-other"}}}}}`, gateway.ReasonNotBound},
	} {
		if status, body := call(tc.method, tc.path, tc.body); status != http.StatusForbidden || appStoreConnectDenialReason(t, body) != tc.reason {
			t.Fatalf("%s %s: %d %s (want %s)", tc.method, tc.path, status, body, tc.reason)
		}
	}
}

func TestAppStoreConnectGatewayNestedPathsUseApplesNamesAndOnlyRead(t *testing.T) {
	f := newAppStoreConnectFixture(t)
	if err := f.st.SetExternalAccountBindingAccess(context.Background(), "workspace-a", f.account.ID, "alice", "commerce"); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/v1/subscriptions/sub-1/introductoryOffers", "/v1/subscriptions/sub-1/prices", "/v1/subscriptions/sub-1/appStoreReviewScreenshot", "/v1/subscriptions/sub-1/subscriptionLocalizations"} {
		if status, body := callAppStoreConnectGateway(f, "device-alice", "alice", http.MethodGet, path, nil, nil); status != http.StatusOK {
			t.Fatalf("GET %s: %d %s", path, status, body)
		}
	}
	for _, path := range []string{"/v1/subscriptions/sub-1/prices", "/v1/subscriptions/sub-1/introductoryOffers", "/v1/subscriptionGroups/group-1/subscriptions"} {
		status, body := callAppStoreConnectGateway(f, "device-alice", "alice", http.MethodPost, path, nil, json.RawMessage(`{"data":{"type":"fixture"}}`))
		if status != http.StatusForbidden || appStoreConnectDenialReason(t, body) != gateway.ReasonPathNotAllowed {
			t.Fatalf("POST %s: %d %s", path, status, body)
		}
	}
}

func TestAppStoreConnectGatewayReadsBuildsOfTheBoundApp(t *testing.T) {
	f := newAppStoreConnectFixture(t)
	for _, path := range []string{"/v1/apps/" + f.boundApp + "/builds", "/v1/builds/build-1"} {
		if status, body := callAppStoreConnectGateway(f, "device-alice", "alice", http.MethodGet, path, nil, nil); status != http.StatusOK {
			t.Fatalf("GET %s: %d %s", path, status, body)
		}
	}
	if err := f.st.SetExternalAccountBindingAccess(context.Background(), "workspace-a", f.account.ID, "alice", "commerce"); err != nil {
		t.Fatal(err)
	}
	status, body := callAppStoreConnectGateway(f, "device-alice", "alice", http.MethodPatch, "/v1/builds/build-1", nil, json.RawMessage(`{"data":{"type":"builds","id":"build-1","attributes":{"expired":true}}}`))
	if status != http.StatusForbidden || appStoreConnectDenialReason(t, body) != gateway.ReasonPathNotAllowed {
		t.Fatalf("PATCH a build: %d %s", status, body)
	}
}
