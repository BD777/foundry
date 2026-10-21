package connectors

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type cfGatewayStore struct {
	*sqlitestore.Store
	session store.AgentSession
	removed bool
}

func (s *cfGatewayStore) GetAgentSessionSummary(_ context.Context, id string) (store.AgentSession, error) {
	if id != s.session.ID {
		return store.AgentSession{}, store.ErrNotFound
	}
	return s.session, nil
}
func (s *cfGatewayStore) DeviceOwner(_ context.Context, id string) (string, error) {
	if id != "device-alice" {
		return "bob", nil
	}
	return "alice", nil
}
func (s *cfGatewayStore) DeviceRemoved(context.Context, string) (bool, error) { return s.removed, nil }
func TestCloudflareGatewayLiveScopeRevocationAndHandleIsolation(t *testing.T) {
	ctx := context.Background()
	st, err := sqlitestore.OpenWithOptions(filepath.Join(t.TempDir(), "db"), sqlitestore.Options{SecretKeyPath: filepath.Join(t.TempDir(), "key")})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	selected := strings.Repeat("a", 32)
	other := strings.Repeat("b", 32)
	calls := []string{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/mcp" || r.Header.Get("Authorization") != "Bearer fixture-cf-access" {
			t.Error("wrong credential audience")
		}
		var input struct {
			Params struct {
				Arguments struct {
					Code string `json:"code"`
				} `json:"arguments"`
			} `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&input)
		code := strings.TrimSuffix(strings.TrimPrefix(input.Params.Arguments.Code, "async () => { return await cloudflare.request("), "); }")
		var call struct{ Method, Path string }
		if json.Unmarshal([]byte(code), &call) != nil || call.Method != "GET" {
			t.Error("unstructured or mutating upstream call")
		}
		calls = append(calls, call.Path)
		if !strings.HasPrefix(call.Path, "/zones/"+selected) {
			t.Error("unbound zone reached provider", call.Path)
		}
		body, _ := json.Marshal(map[string]any{"success": true, "result": map[string]string{"id": selected, "name": "fixture.invalid"}})
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": map[string]any{"content": []any{map[string]any{"type": "text", "text": string(body)}}}})
	}))
	defer upstream.Close()
	adapter := externalaccounts.NewCloudflare()
	adapter.BaseURL = upstream.URL
	adapter.Client = upstream.Client()
	service := externalaccounts.NewService(st, st, externalaccounts.NewRegistry(adapter))
	app, err := st.CreateExternalProviderApp(ctx, store.ExternalProviderApp{ID: "cf-app", Provider: "cloudflare", OwnerUserID: "alice", ClientID: "fixture-public", CreatedVia: "dynamic_registration"})
	if err != nil {
		t.Fatal(err)
	}
	account, err := st.SaveExternalAccount(ctx, store.ExternalAccount{ID: "cf-account", AppID: app.ID, Provider: "cloudflare", OwnerUserID: "alice", Mode: store.ExternalCredentialServerHeld, Status: store.ExternalAccountReady})
	if err != nil {
		t.Fatal(err)
	}
	grant, _ := json.Marshal(externalaccounts.Grant{AccessToken: "fixture-cf-access", RefreshToken: "fixture-cf-refresh", AccessExpiresAt: time.Now().Add(2 * time.Hour), RefreshExpiresAt: time.Now().Add(24 * time.Hour)})
	if err := st.PutSecret(ctx, externalaccounts.GrantSecretID(account.ID), grant, externalaccounts.GrantSecretID(account.ID)); err != nil {
		t.Fatal(err)
	}
	fake := &cfGatewayStore{Store: st, session: store.AgentSession{ID: "session-alice", DeviceID: "device-alice", WorkspaceID: "workspace-a", CreatedByUserID: "alice", Status: "running"}}
	gateway := NewCloudflareGateway(fake, service)
	if err := st.SetWorkspaceExternalAccounts(ctx, "workspace-a", "alice", []string{account.ID}, map[string][]string{account.ID: {selected}}); err != nil {
		t.Fatal(err)
	}
	handle, err := gateway.IssueHandles(ctx, externalaccounts.HandleRequest{SessionID: fake.session.ID, DeviceID: fake.session.DeviceID, WorkspaceID: fake.session.WorkspaceID, UserID: "alice", Account: account})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(handle.UserHandle, "fdycf_user_") || strings.Contains(handle.UserHandle, "fixture-cf-access") {
		t.Fatal("not a stand-in")
	}
	if _, err := gateway.ReadHandle(ctx, handle.UserHandle, "device-alice", "alice", "/zones", nil); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 || calls[0] != "/zones/"+selected {
		t.Fatal("broad zone discovery leaked")
	}
	for _, tc := range []struct{ device, owner, path string }{{"device-bob", "alice", "/zones"}, {"device-alice", "bob", "/zones"}, {"device-alice", "alice", "/zones/" + other + "/dns_records"}, {"device-alice", "alice", "/zones/" + selected + "/../" + other}, {"device-alice", "alice", "/accounts"}} {
		if _, err := gateway.ReadHandle(ctx, handle.UserHandle, tc.device, tc.owner, tc.path, nil); !errors.Is(err, ErrCloudflareAccess) {
			t.Fatalf("scope escaped: %+v %v", tc, err)
		}
	}
	if len(calls) != 1 {
		t.Fatal("rejected requests reached provider")
	}
	fake.session.Source = "verification"
	if _, _, err := gateway.CheckSession(ctx, fake.session.ID, fake.session.DeviceID, "alice", account.ID); err == nil {
		t.Fatal("verifier got credential")
	}
	fake.session.Source = ""
	fake.removed = true
	if _, _, err := gateway.CheckSession(ctx, fake.session.ID, fake.session.DeviceID, "alice", account.ID); err == nil {
		t.Fatal("removed device got credential")
	}
	fake.removed = false
	fake.session.WorkspaceID = "other"
	if _, err := gateway.ReadHandle(ctx, handle.UserHandle, "device-alice", "alice", "/zones", nil); err == nil {
		t.Fatal("handle followed moved workspace")
	}
	fake.session.WorkspaceID = "workspace-a"
	gateway.Now = func() time.Time { return time.Now().Add(31 * time.Minute) }
	if _, err := gateway.ReadHandle(ctx, handle.UserHandle, "device-alice", "alice", "/zones", nil); !errors.Is(err, ErrCloudflareHandleExpired) {
		t.Fatal("expired handle accepted")
	}
	gateway.Now = time.Now
	if err := st.SetWorkspaceExternalAccounts(ctx, "workspace-a", "alice", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := gateway.ReadHandle(ctx, handle.UserHandle, "device-alice", "alice", "/zones", nil); err == nil {
		t.Fatal("unbound handle still works")
	}
	if len(calls) != 1 {
		t.Fatal("revoked access reached provider")
	}
}

func TestCloudflareBoundZoneListQueryContract(t *testing.T) {
	for _, raw := range []string{"page=0", "page=-1", "per_page=51", "name=ignored.invalid", "page=1&page=2", "page=999999999999999999999"} {
		query, _ := url.ParseQuery(raw)
		if err := validateCloudflareRead("/zones", query, nil); err == nil {
			t.Errorf("unsupported query silently accepted: %s", raw)
		}
	}
	query := url.Values{"page": {"2"}, "per_page": {"1"}}
	if err := validateCloudflareRead("/zones", query, nil); err != nil {
		t.Fatal(err)
	}
	page, size := cloudflareZonePage(query)
	if page != 2 || size != 1 {
		t.Fatal(page, size)
	}
}
