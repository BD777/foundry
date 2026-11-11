package connectors

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	ztSecret      = "zero-trust-client-secret-must-not-escape"
	ztAppExisting = "11111111111111111111111111111111"
	ztAppNew      = "22222222222222222222222222222222"
	ztPolicy      = "33333333333333333333333333333333"
	ztToken       = "44444444444444444444444444444444"
	ztTunnel      = "55555555-5555-5555-5555-555555555555"
)

func TestCloudflareZeroTrustClassifiesPathsRefusesUnownedAccountsAndRedactsSecrets(t *testing.T) {
	f := newCloudflareZeroTrustFixture(t, true, false, true)
	apps, err := callGateway(f.gateway, f.handle, f.session.DeviceID, "alice", "GET", "/accounts/"+cfAccount+"/access/apps", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(apps), ztAppExisting) {
		t.Fatalf("Access app read: %s", apps)
	}

	before := len(f.callsSnapshot())
	if _, err := callGateway(f.gateway, f.handle, f.session.DeviceID, "alice", "GET", "/accounts/"+cfOtherAccount+"/access/apps", nil, nil); !errors.Is(err, ErrCloudflareAccess) {
		t.Fatalf("unowned Cloudflare account reached the provider: %v", err)
	}
	if got := len(f.callsSnapshot()); got != before {
		t.Fatalf("unowned account reached upstream: %d calls", got-before)
	}

	bypassPath := "/accounts/" + cfAccount + "/access/apps/" + ztAppExisting + "/policies"
	request := httptest.NewRequest(http.MethodPost, CloudflareGatewayPath+bypassPath, strings.NewReader(`{"name":"bypass","decision":"bypass","include":[]}`))
	need, denied := f.gateway.Classify(request, &gateway.Lease{Session: f.session, Held: gateway.Holdings{Level: externalaccounts.CloudflareAccessZeroTrust}})
	if denied != nil || !need.Write || need.Risk == "" || need.Resource != cfAccount {
		t.Fatalf("Zero Trust write was not classified as a confirmable risk write: need=%+v denied=%+v", need, denied)
	}
	if body, _ := io.ReadAll(request.Body); !strings.Contains(string(body), `"decision":"bypass"`) {
		t.Fatalf("classification consumed the confirmation body: %q", body)
	}
	_, err = callGateway(f.gateway, f.handle, f.session.DeviceID, "alice", "POST", bypassPath, nil, json.RawMessage(`{"name":"bypass","decision":"bypass","include":[]}`))
	if !errors.Is(err, ErrCloudflareAccess) || !strings.Contains(err.Error(), "Bypass") {
		t.Fatalf("bypass was not refused before upstream: %v", err)
	}

	created, err := callGateway(f.gateway, f.handle, f.session.DeviceID, "alice", "POST", "/accounts/"+cfAccount+"/access/service_tokens", nil, json.RawMessage(`{"name":"gateway-created"}`))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(created), ztSecret) || !strings.Contains(string(created), `"client_secret_redacted":true`) {
		t.Fatalf("service token response leaked or did not mark the secret: %s", created)
	}
	for _, event := range f.events(t) {
		if strings.Contains(event.Detail, ztSecret) {
			t.Fatalf("audit line contains the service token secret: %s", event.Detail)
		}
	}
}

func TestCloudflareAutoProvisionCreatesServiceAuthApplicationAndReportsTunnelIngress(t *testing.T) {
	f := newCloudflareZeroTrustFixture(t, false, false, false)
	result, err := f.auto.Provision(context.Background(), CloudflareAutoProvisionInput{
		Owner: "alice", Provider: CloudflareEdgeAccessProvider, Team: "foundry-test.cloudflareaccess.com",
		Host: "Fixture.Invalid", Path: "/lan/",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.AccountID != cfAccount || result.ServiceTokenID != ztToken || result.ApplicationID != ztAppNew || result.PolicyID != ztPolicy || result.EdgeAccessID != "edge-one" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if !result.Tunnel.NeedsIngress || result.Tunnel.SuggestedIngress == nil || result.Tunnel.SuggestedIngress.Hostname != "fixture.invalid" || result.Tunnel.SuggestedIngress.Path != "/lan" {
		t.Fatalf("tunnel gap was not reported: %+v", result.Tunnel)
	}
	if f.edge.writes != 1 || f.edge.input.Match.Host != "fixture.invalid" || f.edge.input.Match.PathPrefix != "/lan" || f.edge.input.Team != "foundry-test.cloudflareaccess.com" || f.edge.input.ClientSecret != ztSecret {
		t.Fatalf("EdgeAccessWriter did not receive the expected write-only input: %+v", f.edge.input)
	}
	if got := f.firstCall("POST", "/accounts/"+cfAccount+"/access/apps"); got == nil {
		t.Fatal("new host/path did not create a self-hosted Access application")
	} else if got.Body["type"] != "self_hosted" || got.Body["domain"] != "fixture.invalid/lan" {
		t.Fatalf("application body: %+v", got.Body)
	}
	policy := f.firstCall("POST", "/accounts/"+cfAccount+"/access/apps/"+ztAppNew+"/policies")
	if policy == nil || policy.Body["decision"] != "non_identity" {
		t.Fatalf("service-auth policy was not created: %+v", policy)
	}
	include, _ := policy.Body["include"].([]any)
	if len(include) != 1 {
		t.Fatalf("policy include selectors: %+v", policy.Body["include"])
	}
	if got := f.firstCall("PUT", "/accounts/"+cfAccount+"/cfd_tunnel/"+ztTunnel+"/configurations"); got != nil {
		t.Fatalf("auto-provision changed Tunnel ingress: %+v", got)
	}
	f.assertNoSecret(t, result)
}

func TestCloudflareAutoProvisionUsesExistingApplicationWithoutChangingHumanPolicies(t *testing.T) {
	f := newCloudflareZeroTrustFixture(t, true, false, true)
	result, err := f.auto.Provision(context.Background(), CloudflareAutoProvisionInput{
		Owner: "alice", Provider: CloudflareEdgeAccessProvider, Team: "foundry-test.cloudflareaccess.com",
		Host: "fixture.invalid", Path: "/lan",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ApplicationID != ztAppExisting || result.Tunnel.NeedsIngress {
		t.Fatalf("existing app or ingress was not reused: %+v", result)
	}
	if got := f.firstCall("POST", "/accounts/"+cfAccount+"/access/apps"); got != nil {
		t.Fatalf("covered app was duplicated: %+v", got)
	}
	policy := f.firstCall("POST", "/accounts/"+cfAccount+"/access/apps/"+ztAppExisting+"/policies")
	if policy == nil || policy.Body["decision"] != "non_identity" {
		t.Fatalf("existing app did not receive a service-auth policy: %+v", policy)
	}
	for _, call := range f.callsSnapshot() {
		if strings.Contains(strings.ToLower(strings.Join(stringMapValues(call.Body), " ")), "bypass") {
			t.Fatalf("auto-provision sent Bypass: %+v", call)
		}
	}
	f.assertNoSecret(t, result)
}

func TestCloudflareAutoProvisionRollsBackCreatedTokenWhenPolicyWriteFails(t *testing.T) {
	f := newCloudflareZeroTrustFixture(t, false, true, false)
	result, err := f.auto.Provision(context.Background(), CloudflareAutoProvisionInput{
		Owner: "alice", Provider: CloudflareEdgeAccessProvider, Team: "foundry-test.cloudflareaccess.com",
		Host: "fixture.invalid", Path: "/lan",
	})
	if err == nil {
		t.Fatal("policy failure succeeded")
	}
	if !result.RollbackComplete || f.edge.writes != 0 {
		t.Fatalf("failure was not rolled back or reached EdgeAccessWriter: %+v", result)
	}
	if got := f.firstCall("DELETE", "/accounts/"+cfAccount+"/access/service_tokens/"+ztToken); got == nil {
		t.Fatal("created service token was not deleted")
	}
	if got := f.firstCall("DELETE", "/accounts/"+cfAccount+"/access/apps/"+ztAppNew); got == nil {
		t.Fatal("newly created application was not deleted during rollback")
	}
	f.assertNoSecret(t, result, err)
}

type ztUpstreamCall struct {
	Method string              `json:"method"`
	Path   string              `json:"path"`
	Query  map[string][]string `json:"query"`
	Body   map[string]any      `json:"body"`
}

type cloudflareZeroTrustFixture struct {
	st      *sqlitestore.Store
	gateway *CloudflareGateway
	auto    *CloudflareAutoProvisioner
	edge    *recordingEdgeAccessWriter
	session store.AgentSession
	account store.ExternalAccount
	handle  string

	mu                   sync.Mutex
	calls                []ztUpstreamCall
	apps                 []cloudflareZeroTrustApplication
	failPolicy           bool
	configHasIngress     bool
	tokenDeleteSucceeded bool
}

type recordingEdgeAccessWriter struct {
	writes int
	input  EdgeAccessCreateInput
}

func (w *recordingEdgeAccessWriter) CreateEdgeAccess(_ context.Context, _ string, input EdgeAccessCreateInput) (string, error) {
	w.writes++
	w.input = input
	return "edge-one", nil
}

func newCloudflareZeroTrustFixture(t *testing.T, existingApp, failPolicy, configHasIngress bool) *cloudflareZeroTrustFixture {
	t.Helper()
	ctx := context.Background()
	st, err := sqlitestore.OpenWithOptions(filepath.Join(t.TempDir(), "db"), sqlitestore.Options{SecretKeyPath: filepath.Join(t.TempDir(), "key")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	f := &cloudflareZeroTrustFixture{st: st, failPolicy: failPolicy, configHasIngress: configHasIngress}
	if existingApp {
		f.apps = []cloudflareZeroTrustApplication{{ID: ztAppExisting, Domain: "fixture.invalid/lan*"}}
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/mcp" || r.Header.Get("Authorization") != "Bearer fixture-cf-access" {
			http.Error(w, "wrong credential", http.StatusUnauthorized)
			return
		}
		var input struct {
			Params struct {
				Arguments struct {
					Code string `json:"code"`
				} `json:"arguments"`
			} `json:"params"`
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			http.Error(w, "bad MCP request", http.StatusBadRequest)
			return
		}
		code := strings.TrimSuffix(strings.TrimPrefix(input.Params.Arguments.Code, "async () => { return await cloudflare.request("), "); }")
		var call ztUpstreamCall
		if json.Unmarshal([]byte(code), &call) != nil {
			http.Error(w, "unstructured upstream call", http.StatusBadRequest)
			return
		}
		f.mu.Lock()
		f.calls = append(f.calls, call)
		f.mu.Unlock()
		f.answer(t, w, call)
	}))
	t.Cleanup(upstream.Close)

	adapter := externalaccounts.NewCloudflare()
	adapter.BaseURL = upstream.URL
	adapter.Client = upstream.Client()
	service := externalaccounts.NewService(st, st, externalaccounts.NewRegistry(adapter))
	app, err := st.CreateExternalProviderApp(ctx, store.ExternalProviderApp{ID: "cf-app", Provider: "cloudflare", OwnerUserID: "alice", ClientID: "fixture-public", CreatedVia: "dynamic_registration"})
	if err != nil {
		t.Fatal(err)
	}
	f.account, err = st.SaveExternalAccount(ctx, store.ExternalAccount{
		ID: "cf-account", AppID: app.ID, Provider: "cloudflare", OwnerUserID: "alice",
		Mode: store.ExternalCredentialServerHeld, Status: store.ExternalAccountReady,
		GrantedScopes: []string{"zone.read", "dns.read", "dns.write", "ssl-and-certificates.read", "access-app.read", "access-app.write", "access-policy.read", "access-policy.write", "access-service-token.read", "access-service-token.write", "argotunnel.read", "argotunnel.write"},
	})
	if err != nil {
		t.Fatal(err)
	}
	grant, _ := json.Marshal(externalaccounts.Grant{AccessToken: "fixture-cf-access", RefreshToken: "fixture-cf-refresh", AccessExpiresAt: time.Now().Add(2 * time.Hour), RefreshExpiresAt: time.Now().Add(24 * time.Hour)})
	if err := st.PutSecret(ctx, externalaccounts.GrantSecretID(f.account.ID), grant, externalaccounts.GrantSecretID(f.account.ID)); err != nil {
		t.Fatal(err)
	}
	f.session = store.AgentSession{ID: "session-alice", DeviceID: "device-alice", WorkspaceID: "workspace-a", CreatedByUserID: "alice", Status: "running"}
	f.gateway = NewCloudflareGateway(&cfGatewayStore{Store: st, session: f.session}, service)
	if err := st.SetWorkspaceExternalAccounts(ctx, "workspace-a", "alice", []string{f.account.ID}, map[string][]string{f.account.ID: {cfZone}}); err != nil {
		t.Fatal(err)
	}
	if err := st.SetExternalAccountBindingAccess(ctx, "workspace-a", f.account.ID, "alice", externalaccounts.CloudflareAccessZeroTrust); err != nil {
		t.Fatal(err)
	}
	issued, err := f.gateway.IssueHandles(ctx, externalaccounts.HandleRequest{SessionID: f.session.ID, DeviceID: f.session.DeviceID, WorkspaceID: f.session.WorkspaceID, UserID: "alice", Account: f.account})
	if err != nil {
		t.Fatal(err)
	}
	f.handle = issued.UserHandle
	f.edge = &recordingEdgeAccessWriter{}
	f.auto = NewCloudflareAutoProvisioner(st, service, f.edge)
	f.auto.Random = func(int) (string, error) { return "abc123", nil }
	return f
}

func (f *cloudflareZeroTrustFixture) answer(t *testing.T, w http.ResponseWriter, call ztUpstreamCall) {
	t.Helper()
	respond := func(result any) {
		body, _ := json.Marshal(map[string]any{"success": true, "errors": []any{}, "result": result})
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": map[string]any{"content": []any{map[string]any{"type": "text", "text": string(body)}}}})
	}
	fail := func(code int, message string) {
		text := `Cloudflare API error 400: {"success":false,"errors":[{"code":1000,"message":"` + message + `"}]}`
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": map[string]any{"isError": true, "content": []any{map[string]any{"type": "text", "text": text}}}})
	}
	switch {
	case call.Method == "GET" && call.Path == "/zones":
		respond([]any{map[string]any{"id": cfZone, "name": "fixture.invalid", "account": map[string]any{"id": cfAccount}}})
	case call.Method == "GET" && call.Path == "/zones/"+cfZone:
		respond(map[string]any{"id": cfZone, "name": "fixture.invalid", "account": map[string]any{"id": cfAccount}})
	case call.Method == "GET" && call.Path == "/accounts/"+cfAccount+"/access/apps":
		f.mu.Lock()
		apps := append([]cloudflareZeroTrustApplication(nil), f.apps...)
		f.mu.Unlock()
		respond(apps)
	case call.Method == "POST" && call.Path == "/accounts/"+cfAccount+"/access/service_tokens":
		respond(map[string]any{"id": ztToken, "client_id": "foundry-client-id", "client_secret": ztSecret, "name": call.Body["name"]})
	case call.Method == "DELETE" && call.Path == "/accounts/"+cfAccount+"/access/service_tokens/"+ztToken:
		f.mu.Lock()
		f.tokenDeleteSucceeded = true
		f.mu.Unlock()
		respond(map[string]any{"id": ztToken})
	case call.Method == "POST" && call.Path == "/accounts/"+cfAccount+"/access/apps":
		respond(map[string]any{"id": ztAppNew, "domain": call.Body["domain"], "type": "self_hosted"})
	case call.Method == "DELETE" && call.Path == "/accounts/"+cfAccount+"/access/apps/"+ztAppNew:
		respond(map[string]any{"id": ztAppNew})
	case call.Method == "POST" && strings.HasPrefix(call.Path, "/accounts/"+cfAccount+"/access/apps/") && strings.HasSuffix(call.Path, "/policies"):
		if f.failPolicy {
			fail(1000, "policy write failed")
			return
		}
		respond(map[string]any{"id": ztPolicy, "decision": call.Body["decision"]})
	case call.Method == "DELETE" && strings.HasSuffix(call.Path, "/policies/"+ztPolicy):
		respond(map[string]any{"id": ztPolicy})
	case call.Method == "GET" && call.Path == "/accounts/"+cfAccount+"/cfd_tunnel":
		respond([]any{map[string]any{"id": ztTunnel, "name": "fixture"}})
	case call.Method == "GET" && call.Path == "/accounts/"+cfAccount+"/cfd_tunnel/"+ztTunnel+"/configurations":
		ingress := []any{map[string]any{"service": "http_status:404"}}
		if f.configHasIngress {
			ingress = []any{map[string]any{"hostname": "fixture.invalid", "path": "/lan", "service": "http://127.0.0.1:8080"}, map[string]any{"service": "http_status:404"}}
		}
		respond(map[string]any{"config": map[string]any{"ingress": ingress}})
	default:
		fail(1000, "unexpected upstream call "+call.Method+" "+call.Path)
	}
}

func (f *cloudflareZeroTrustFixture) firstCall(method, endpoint string) *ztUpstreamCall {
	for _, call := range f.callsSnapshot() {
		if call.Method == method && call.Path == endpoint {
			copy := call
			return &copy
		}
	}
	return nil
}

func (f *cloudflareZeroTrustFixture) callsSnapshot() []ztUpstreamCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]ztUpstreamCall(nil), f.calls...)
}

func (f *cloudflareZeroTrustFixture) events(t *testing.T) []store.ExternalAccountEvent {
	t.Helper()
	events, err := f.st.ListExternalAccountEvents(context.Background(), f.account.ID, 100)
	if err != nil {
		t.Fatal(err)
	}
	return events
}

func (f *cloudflareZeroTrustFixture) assertNoSecret(t *testing.T, values ...any) {
	t.Helper()
	for _, value := range values {
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(raw), ztSecret) {
			t.Fatalf("secret escaped in %T: %s", value, raw)
		}
	}
	for _, call := range f.callsSnapshot() {
		raw, _ := json.Marshal(call)
		if strings.Contains(string(raw), ztSecret) {
			t.Fatalf("secret entered an upstream call: %s", raw)
		}
	}
	for _, event := range f.events(t) {
		if strings.Contains(event.Detail, ztSecret) {
			t.Fatalf("secret entered an audit event: %s", event.Detail)
		}
	}
}

func stringMapValues(values map[string]any) []string {
	out := make([]string, 0, len(values))
	for key, value := range values {
		raw, _ := json.Marshal(value)
		out = append(out, key+"="+string(raw))
	}
	return out
}
