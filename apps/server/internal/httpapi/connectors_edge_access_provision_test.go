package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	edgeProvisionGrant        = "fixture-cf-access-token"
	edgeProvisionClientID     = "fixture-client-id-do-not-return"
	edgeProvisionClientSecret = "fixture-client-secret-do-not-return"
	edgeProvisionAccountID    = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	edgeProvisionTokenID      = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	edgeProvisionAppID        = "cccccccccccccccccccccccccccccccc"
	edgeProvisionPolicyID     = "dddddddddddddddddddddddddddddddd"
	edgeProvisionTunnelID     = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"
)

type provisionUpstreamCall struct {
	Method string              `json:"method"`
	Path   string              `json:"path"`
	Query  map[string][]string `json:"query"`
	Body   map[string]any      `json:"body"`
}

type edgeProvisionFixture struct {
	*externalAccountsFixture
	mu    sync.Mutex
	calls []provisionUpstreamCall
}

func newEdgeProvisionFixture(t *testing.T, scopes []string) *edgeProvisionFixture {
	t.Helper()
	f := &edgeProvisionFixture{externalAccountsFixture: newExternalAccountsFixture(t)}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/mcp" || r.Header.Get("Authorization") != "Bearer "+edgeProvisionGrant {
			http.Error(w, "wrong credential", http.StatusUnauthorized)
			return
		}
		var request struct {
			Params struct {
				Arguments struct {
					Code string `json:"code"`
				} `json:"arguments"`
			} `json:"params"`
		}
		if json.NewDecoder(r.Body).Decode(&request) != nil {
			http.Error(w, "bad MCP request", http.StatusBadRequest)
			return
		}
		code := strings.TrimSuffix(strings.TrimPrefix(request.Params.Arguments.Code, "async () => { return await cloudflare.request("), "); }")
		var call provisionUpstreamCall
		if json.Unmarshal([]byte(code), &call) != nil {
			http.Error(w, "unstructured upstream call", http.StatusBadRequest)
			return
		}
		f.mu.Lock()
		f.calls = append(f.calls, call)
		f.mu.Unlock()
		reply := func(result any) {
			envelope, _ := json.Marshal(map[string]any{"success": true, "errors": []any{}, "result": result})
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      1,
				"result": map[string]any{
					"content": []any{map[string]any{"type": "text", "text": string(envelope)}},
				},
			})
		}
		switch {
		case call.Method == http.MethodGet && call.Path == "/zones":
			reply([]any{map[string]any{
				"id":      strings.Repeat("f", 32),
				"name":    "fixture.invalid",
				"account": map[string]any{"id": edgeProvisionAccountID},
			}})
		case call.Method == http.MethodGet && call.Path == "/accounts/"+edgeProvisionAccountID+"/access/apps":
			reply([]any{})
		case call.Method == http.MethodPost && call.Path == "/accounts/"+edgeProvisionAccountID+"/access/service_tokens":
			reply(map[string]any{
				"id":            edgeProvisionTokenID,
				"name":          call.Body["name"],
				"client_id":     edgeProvisionClientID,
				"client_secret": edgeProvisionClientSecret,
			})
		case call.Method == http.MethodPost && call.Path == "/accounts/"+edgeProvisionAccountID+"/access/apps":
			reply(map[string]any{"id": edgeProvisionAppID, "domain": call.Body["domain"], "type": "self_hosted"})
		case call.Method == http.MethodPost && call.Path == "/accounts/"+edgeProvisionAccountID+"/access/apps/"+edgeProvisionAppID+"/policies":
			reply(map[string]any{"id": edgeProvisionPolicyID, "decision": call.Body["decision"]})
		case call.Method == http.MethodGet && call.Path == "/accounts/"+edgeProvisionAccountID+"/cfd_tunnel":
			reply([]any{map[string]any{"id": edgeProvisionTunnelID, "name": "fixture"}})
		case call.Method == http.MethodGet && call.Path == "/accounts/"+edgeProvisionAccountID+"/cfd_tunnel/"+edgeProvisionTunnelID+"/configurations":
			reply(map[string]any{"config": map[string]any{"ingress": []any{map[string]any{"service": "http_status:404"}}}})
		default:
			http.Error(w, "unexpected upstream call "+call.Method+" "+call.Path, http.StatusBadRequest)
		}
	}))
	t.Cleanup(upstream.Close)

	adapter := externalaccounts.NewCloudflare()
	adapter.BaseURL = upstream.URL
	adapter.Client = upstream.Client()
	service := externalaccounts.NewService(f.db, f.db, externalaccounts.NewRegistry(adapter))
	f.server.connectors.ServerHeld = service

	ctx := context.Background()
	app, err := f.db.CreateExternalProviderApp(ctx, store.ExternalProviderApp{
		ID: "cf-edge-provision-app", Provider: "cloudflare", OwnerUserID: f.aliceID,
		ClientID: "fixture-public", CreatedVia: "dynamic_registration",
	})
	if err != nil {
		t.Fatal(err)
	}
	account, err := f.db.SaveExternalAccount(ctx, store.ExternalAccount{
		ID: "cf-edge-provision-account", AppID: app.ID, Provider: "cloudflare",
		OwnerUserID: f.aliceID, Mode: store.ExternalCredentialServerHeld,
		Status: store.ExternalAccountReady, GrantedScopes: scopes,
	})
	if err != nil {
		t.Fatal(err)
	}
	grant, _ := json.Marshal(externalaccounts.Grant{
		AccessToken: edgeProvisionGrant, RefreshToken: "fixture-refresh",
		AccessExpiresAt: time.Now().Add(time.Hour), RefreshExpiresAt: time.Now().Add(24 * time.Hour),
	})
	if err := f.db.PutSecret(ctx, externalaccounts.GrantSecretID(account.ID), grant, externalaccounts.GrantSecretID(account.ID)); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *edgeProvisionFixture) callsSnapshot() []provisionUpstreamCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]provisionUpstreamCall(nil), f.calls...)
}

func TestEdgeAccessProvisionHTTP(t *testing.T) {
	zeroTrust, _ := externalaccounts.CloudflareAccessLevel(externalaccounts.CloudflareAccessZeroTrust)
	fullScopes := append([]string{"offline_access", "user:read", "account:read"}, zeroTrust.Scopes...)

	t.Run("success stores metadata and reports ingress", func(t *testing.T) {
		f := newEdgeProvisionFixture(t, fullScopes)
		body := `{"provider":"cloudflare_access","team":"fixture.cloudflareaccess.com","host":"Fixture.Invalid","path":"/lan/"}`
		response := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/edge-access/provision", body))
		expectStatus(t, response, http.StatusCreated, "provision edge access")

		var result struct {
			EdgeAccess       store.EdgeAccess                        `json:"edgeAccess"`
			AccountID        string                                  `json:"accountId"`
			ServiceTokenName string                                  `json:"serviceTokenName"`
			ServiceTokenID   string                                  `json:"serviceTokenId"`
			ApplicationID    string                                  `json:"applicationId"`
			PolicyID         string                                  `json:"policyId"`
			NeedsIngress     bool                                    `json:"needsIngress"`
			SuggestedIngress *connectors.EdgeAccessIngressSuggestion `json:"suggestedIngress"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if result.EdgeAccess.ID == "" || result.EdgeAccess.Match.Host != "fixture.invalid" || result.EdgeAccess.Match.PathPrefix != "/lan" ||
			result.EdgeAccess.Team != "fixture.cloudflareaccess.com" {
			t.Fatalf("created EdgeAccess: %+v", result.EdgeAccess)
		}
		if result.AccountID != edgeProvisionAccountID || result.ServiceTokenID != edgeProvisionTokenID ||
			result.ApplicationID != edgeProvisionAppID || result.PolicyID != edgeProvisionPolicyID {
			t.Fatalf("provision ids: %+v", result)
		}
		tokenPrefix := "foundry-fixture.invalid-"
		if !strings.HasPrefix(result.ServiceTokenName, tokenPrefix) || len(strings.TrimPrefix(result.ServiceTokenName, tokenPrefix)) != 12 {
			t.Fatalf("service token name = %q", result.ServiceTokenName)
		}
		if !result.NeedsIngress || result.SuggestedIngress == nil ||
			result.SuggestedIngress.Hostname != "fixture.invalid" || result.SuggestedIngress.Path != "/lan" ||
			result.SuggestedIngress.Service != "http://<origin>" {
			t.Fatalf("tunnel suggestion: %+v", result)
		}
		if got := len(f.callsSnapshot()); got != 7 {
			t.Fatalf("upstream calls = %d, want 7", got)
		}
		listed := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/edge-access", ""))
		for _, secret := range []string{edgeProvisionGrant, edgeProvisionClientID, edgeProvisionClientSecret} {
			if strings.Contains(response.Body.String(), secret) || strings.Contains(listed.Body.String(), secret) {
				t.Fatalf("provision response exposed %q: %s", secret, response.Body.String())
			}
		}
	})

	t.Run("missing zero trust authorization writes nothing", func(t *testing.T) {
		f := newEdgeProvisionFixture(t, []string{"offline_access", "user:read", "account:read", "zone.read", "dns.read"})
		body := `{"provider":"cloudflare_access","team":"fixture.cloudflareaccess.com","host":"fixture.invalid","path":"/lan"}`
		response := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/edge-access/provision", body))
		expectStatus(t, response, http.StatusForbidden, "provision without Zero Trust")
		var refusal struct {
			Code  string `json:"code"`
			Error string `json:"error"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &refusal); err != nil {
			t.Fatal(err)
		}
		if refusal.Code != edgeAccessZeroTrustRequiredCode || refusal.Error != edgeAccessZeroTrustRequiredMessage {
			t.Fatalf("refusal = %+v", refusal)
		}
		if got := len(f.callsSnapshot()); got != 0 {
			t.Fatalf("missing Zero Trust authorization reached Cloudflare: %d calls", got)
		}
		if listed := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/edge-access", "")); strings.Contains(listed.Body.String(), "fixture.invalid") {
			t.Fatalf("failed provisioning stored an EdgeAccess: %s", listed.Body.String())
		}
		for _, secret := range []string{edgeProvisionGrant, edgeProvisionClientID, edgeProvisionClientSecret} {
			if strings.Contains(response.Body.String(), secret) {
				t.Fatalf("refusal exposed %q: %s", secret, response.Body.String())
			}
		}
	})
}
