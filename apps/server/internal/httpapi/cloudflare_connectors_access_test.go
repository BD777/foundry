package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// DEV-092: the owner sets a workspace's Cloudflare access level; with DNS
// edit a session adds and removes a record through the cloudflare tool and
// both show in the account's activity.
func TestCloudflareAccessLevelAndActivityHTTP(t *testing.T) {
	f := newExternalAccountsFixture(t)
	zone, record := strings.Repeat("a", 32), strings.Repeat("c", 32)
	methods := []string{}
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Params struct {
				Arguments struct {
					Code string `json:"code"`
				} `json:"arguments"`
			} `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&input)
		var call struct {
			Method string         `json:"method"`
			Path   string         `json:"path"`
			Body   map[string]any `json:"body"`
		}
		code := strings.TrimSuffix(strings.TrimPrefix(input.Params.Arguments.Code, "async () => { return await cloudflare.request("), "); }")
		if err := json.Unmarshal([]byte(code), &call); err != nil {
			t.Error("unstructured upstream call")
		}
		methods = append(methods, call.Method)
		result := map[string]any{"id": record, "name": "lan.fixture.invalid", "type": "A", "content": "192.0.2.10"}
		if call.Body != nil {
			result["name"], result["type"], result["content"] = call.Body["name"], call.Body["type"], call.Body["content"]
		}
		body, _ := json.Marshal(map[string]any{"success": true, "result": result})
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": map[string]any{"content": []any{map[string]any{"type": "text", "text": string(body)}}}})
	}))
	defer fake.Close()
	adapter := externalaccounts.NewCloudflare()
	adapter.BaseURL = fake.URL
	adapter.Client = fake.Client()
	service := externalaccounts.NewService(f.db, f.db, externalaccounts.NewRegistry(adapter))
	f.server.connectors.ServerHeld = service
	f.server.connectors.Cloudflare = connectors.NewCloudflareGateway(f.db, service)
	ctx := context.Background()
	app, err := f.db.CreateExternalProviderApp(ctx, store.ExternalProviderApp{ID: "cf-app", Provider: "cloudflare", OwnerUserID: f.aliceID, ClientID: "fixture-public", CreatedVia: "dynamic_registration"})
	if err != nil {
		t.Fatal(err)
	}
	account, err := f.db.SaveExternalAccount(ctx, store.ExternalAccount{ID: "cf-account", AppID: app.ID, Provider: "cloudflare", OwnerUserID: f.aliceID, Mode: store.ExternalCredentialServerHeld, Status: store.ExternalAccountReady, Subject: "user:fixture", GrantedScopes: []string{"zone.read", "dns.read"}})
	if err != nil {
		t.Fatal(err)
	}
	grant, _ := json.Marshal(externalaccounts.Grant{AccessToken: "fixture-access", RefreshToken: "fixture-refresh", AccessExpiresAt: time.Now().Add(time.Hour), RefreshExpiresAt: time.Now().Add(24 * time.Hour)})
	if err := f.db.PutSecret(ctx, externalaccounts.GrantSecretID(account.ID), grant, externalaccounts.GrantSecretID(account.ID)); err != nil {
		t.Fatal(err)
	}
	accessPath := "/api/workspaces/ws_alice/external-accounts/" + account.ID + "/access"
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, "PUT", accessPath, `{"access":"read"}`)), 404, "level before any binding")
	body, _ := json.Marshal(map[string]any{"accountIds": []string{account.ID}, "resources": map[string][]string{account.ID: {zone}}})
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, "PUT", "/api/workspaces/ws_alice/external-accounts", string(body))), 200, "bind")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, "PUT", accessPath, `{"access":"dns_edit"}`)), 409, "level without dns.write")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, "PUT", accessPath, `{"access":"everything"}`)), 400, "unknown level")
	account.GrantedScopes = append(account.GrantedScopes, "dns.write")
	if _, err := f.db.SaveExternalAccount(ctx, account); err != nil {
		t.Fatal(err)
	}
	if status := doAuthCall(t, f.handler, f.as(f.bob, "PUT", "/api/workspaces/ws_bob/external-accounts/"+account.ID+"/access", `{"access":"dns_edit"}`)).Code; status != 404 && status != 403 {
		t.Fatalf("another person set the level: %d", status)
	}

	active, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice", Provider: "claude", Prompt: "add the LAN record", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	actor := Actor{Kind: ActorAgent, Identity: store.SessionTokenIdentity{SessionID: active.ID, WorkspaceID: active.WorkspaceID}}
	call := func(args map[string]any) (any, error) {
		raw := map[string]json.RawMessage{}
		for k, v := range args {
			raw[k], _ = json.Marshal(v)
		}
		return f.server.mcpCloudflare(httptest.NewRequest("POST", "/mcp", nil), actor, raw)
	}
	create := map[string]any{"action": "request", "accountId": account.ID, "method": "POST", "path": "/zones/" + zone + "/dns_records", "body": map[string]any{"type": "A", "name": "lan.fixture.invalid", "content": "192.0.2.10", "ttl": 1, "proxied": false}}
	if _, err := call(create); err == nil || !strings.Contains(err.Error(), "dns_edit") || !strings.Contains(err.Error(), "Connectors → Cloudflare") {
		t.Fatalf("read level did not explain the refusal: %v", err)
	}
	if _, err := call(map[string]any{"action": "request", "accountId": account.ID, "path": "/zones/" + zone + "/dns_records", "body": map[string]any{"type": "A"}}); err == nil {
		t.Fatal("a GET with a body was sent")
	}

	set := doAuthCall(t, f.handler, f.as(f.alice, "PUT", accessPath, `{"access":"dns_edit"}`))
	expectStatus(t, set, 200, "set dns_edit")
	var view store.WorkspaceExternalAccounts
	_ = json.Unmarshal(set.Body.Bytes(), &view)
	if len(view.Bindings) != 1 || view.Bindings[0].Access != "dns_edit" {
		t.Fatalf("binding view lacks the level: %+v", view.Bindings)
	}
	listed, err := call(map[string]any{"action": "accounts"})
	if err != nil {
		t.Fatal(err)
	}
	if encoded, _ := json.Marshal(listed); !strings.Contains(string(encoded), `"access":"dns_edit"`) {
		t.Fatalf("accounts do not show the level: %s", encoded)
	}
	if _, err := call(create); err != nil {
		t.Fatal(err)
	}
	if _, err := call(map[string]any{"action": "request", "accountId": account.ID, "method": "DELETE", "path": "/zones/" + zone + "/dns_records/" + record}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(methods, ",") != "POST,GET,DELETE" {
		t.Fatalf("upstream calls %v", methods)
	}
	if _, err := call(map[string]any{"action": "request", "accountId": account.ID, "method": "POST", "path": "/zones/" + zone + "/purge_cache", "body": map[string]any{"purge_everything": true}}); err == nil {
		t.Fatal("dns_edit allowed a cache purge")
	}

	expectStatus(t, doAuthCall(t, f.handler, f.as(f.bob, "GET", "/api/connectors/cloudflare/accounts/"+account.ID+"/activity", "")), 404, "other person's activity")
	activity := doAuthCall(t, f.handler, f.as(f.alice, "GET", "/api/connectors/cloudflare/accounts/"+account.ID+"/activity", ""))
	expectStatus(t, activity, 200, "activity")
	var log struct {
		Entries []store.CloudflareActivityEntry `json:"entries"`
	}
	if err := json.Unmarshal(activity.Body.Bytes(), &log); err != nil {
		t.Fatal(err)
	}
	summary := []string{}
	for _, e := range log.Entries {
		summary = append(summary, e.Kind+":"+e.Method+":"+e.RecordName+":"+e.Result+":"+e.To)
		if e.WorkspaceID != "ws_alice" || e.WorkspaceName == "" {
			t.Fatalf("entry lacks its workspace: %+v", e)
		}
		if e.Kind == connectors.CloudflareWriteEvent && (e.SessionID != active.ID || e.SessionTitle == "") {
			t.Fatalf("entry lacks its session: %+v", e)
		}
	}
	want := []string{
		"cloudflare_write:POST::refused:",
		"cloudflare_write:DELETE:lan.fixture.invalid:succeeded:",
		"cloudflare_write:POST:lan.fixture.invalid:succeeded:",
		"access_changed::::dns_edit",
		"cloudflare_write:POST:lan.fixture.invalid:refused:",
	}
	if strings.Join(summary, "|") != strings.Join(want, "|") {
		t.Fatalf("activity\n got %v\nwant %v", summary, want)
	}
	if strings.Contains(activity.Body.String(), "fixture-access") {
		t.Fatal("activity holds a token")
	}
}
