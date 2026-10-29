package connectors

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type cfUpstreamCall struct {
	Method string         `json:"method"`
	Path   string         `json:"path"`
	Body   map[string]any `json:"body"`
}

// cfWriteFixture is a gateway whose upstream is a fake official MCP that
// answers like the Cloudflare API and records every call it receives.
type cfWriteFixture struct {
	st      *sqlitestore.Store
	gateway *CloudflareGateway
	session store.AgentSession
	account store.ExternalAccount
	mu      sync.Mutex
	calls   []cfUpstreamCall
	failAPI bool
}

const cfZone = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const cfOtherZone = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const cfRecord = "cccccccccccccccccccccccccccccccc"

func newCFWriteFixture(t *testing.T, scopes []string) *cfWriteFixture {
	t.Helper()
	ctx := context.Background()
	st, err := sqlitestore.OpenWithOptions(filepath.Join(t.TempDir(), "db"), sqlitestore.Options{SecretKeyPath: filepath.Join(t.TempDir(), "key")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	f := &cfWriteFixture{st: st}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Params struct {
				Arguments struct {
					Code string `json:"code"`
				} `json:"arguments"`
			} `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&input)
		code := strings.TrimSuffix(strings.TrimPrefix(input.Params.Arguments.Code, "async () => { return await cloudflare.request("), "); }")
		var call cfUpstreamCall
		if err := json.Unmarshal([]byte(code), &call); err != nil {
			t.Errorf("unstructured upstream call: %v", err)
		}
		f.mu.Lock()
		f.calls = append(f.calls, call)
		failAPI := f.failAPI
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if failAPI {
			text := `Cloudflare API error 400: {"success":false,"errors":[{"code":81057,"message":"An identical record already exists."}]}`
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": map[string]any{"isError": true, "content": []any{map[string]any{"type": "text", "text": text}}}})
			return
		}
		record := map[string]any{"id": cfRecord, "name": "lan.fixture.invalid", "type": "A", "content": "192.0.2.10"}
		if call.Method == "DELETE" {
			record = map[string]any{"id": cfRecord}
		}
		if call.Method == "POST" || call.Method == "PATCH" || call.Method == "PUT" {
			for _, key := range []string{"name", "type", "content"} {
				if value, ok := call.Body[key]; ok {
					record[key] = value
				}
			}
		}
		body, _ := json.Marshal(map[string]any{"success": true, "errors": []any{}, "result": record})
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": map[string]any{"content": []any{map[string]any{"type": "text", "text": string(body)}}}})
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
	f.account, err = st.SaveExternalAccount(ctx, store.ExternalAccount{ID: "cf-account", AppID: app.ID, Provider: "cloudflare", OwnerUserID: "alice", Mode: store.ExternalCredentialServerHeld, Status: store.ExternalAccountReady, GrantedScopes: scopes})
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
	return f
}

func (f *cfWriteFixture) request(method, path, body string) (json.RawMessage, error) {
	var raw json.RawMessage
	if body != "" {
		raw = json.RawMessage(body)
	}
	return f.gateway.RequestSession(context.Background(), f.session.ID, f.session.DeviceID, "alice", f.session.WorkspaceID, f.account.ID, method, path, raw)
}

func (f *cfWriteFixture) writes(t *testing.T) []CloudflareWriteDetail {
	t.Helper()
	events, err := f.st.ListExternalAccountEvents(context.Background(), f.account.ID, 100)
	if err != nil {
		t.Fatal(err)
	}
	out := []CloudflareWriteDetail{}
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].Kind != CloudflareWriteEvent {
			continue
		}
		if events[i].SessionID != f.session.ID || strings.Contains(events[i].Detail, "fixture-cf-access") {
			t.Fatalf("audit line lacks the session or holds a token: %+v", events[i])
		}
		var detail CloudflareWriteDetail
		if err := json.Unmarshal([]byte(events[i].Detail), &detail); err != nil {
			t.Fatal(err)
		}
		out = append(out, detail)
	}
	return out
}

func (f *cfWriteFixture) upstreamCalls() []cfUpstreamCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]cfUpstreamCall(nil), f.calls...)
}

func TestCloudflareReadLevelRefusesChangesWithTheLevelThatAllowsThem(t *testing.T) {
	f := newCFWriteFixture(t, []string{"zone.read", "dns.read", "dns.write"})
	_, err := f.request("POST", "/zones/"+cfZone+"/dns_records", `{"type":"A","name":"lan","content":"192.0.2.10"}`)
	var refusal *CloudflareRefusal
	if !errors.As(err, &refusal) || !errors.Is(err, ErrCloudflareAccess) {
		t.Fatalf("read level let a change through: %v", err)
	}
	for _, want := range []string{"dns_edit", "read access", "Connectors → Cloudflare"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("refusal %q does not say %q", err, want)
		}
	}
	if calls := f.upstreamCalls(); len(calls) != 0 {
		t.Fatalf("refused change reached Cloudflare: %+v", calls)
	}
	if lines := f.writes(t); len(lines) != 1 || lines[0].Result != "refused" || lines[0].Method != "POST" || lines[0].WorkspaceID != "workspace-a" || lines[0].Path != "/zones/:id/dns_records" {
		t.Fatalf("refused change not logged: %+v", lines)
	}
}

func TestCloudflareDNSEditAllowsRecordChangesInBoundZonesOnly(t *testing.T) {
	f := newCFWriteFixture(t, []string{"zone.read", "dns.read", "dns.write"})
	ctx := context.Background()
	if err := f.st.SetExternalAccountBindingAccess(ctx, "workspace-a", f.account.ID, "alice", externalaccounts.CloudflareAccessDNSEdit); err != nil {
		t.Fatal(err)
	}
	created, err := f.request("POST", "/zones/"+cfZone+"/dns_records", `{"type":"TXT","name":"_acme-challenge.lan","content":"token-value","ttl":60}`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(created), `"success":true`) {
		t.Fatalf("create answer: %s", created)
	}
	if _, err := f.request("PATCH", "/zones/"+cfZone+"/dns_records/"+cfRecord, `{"content":"192.0.2.11"}`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.request("PUT", "/zones/"+cfZone+"/dns_records/"+cfRecord, `{"type":"A","name":"lan","content":"192.0.2.12"}`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.request("DELETE", "/zones/"+cfZone+"/dns_records/"+cfRecord, ""); err != nil {
		t.Fatal(err)
	}
	calls := f.upstreamCalls()
	methods := []string{}
	for _, c := range calls {
		methods = append(methods, c.Method+" "+strings.ReplaceAll(strings.ReplaceAll(c.Path, cfZone, "Z"), cfRecord, "R"))
	}
	want := []string{"POST /zones/Z/dns_records", "PATCH /zones/Z/dns_records/R", "PUT /zones/Z/dns_records/R", "GET /zones/Z/dns_records/R", "DELETE /zones/Z/dns_records/R"}
	if strings.Join(methods, ",") != strings.Join(want, ",") {
		t.Fatalf("upstream calls %v, want %v", methods, want)
	}
	if calls[0].Body["ttl"] == nil || calls[4].Body != nil {
		t.Fatalf("body not passed as data, or a DELETE carried one: %+v", calls)
	}
	lines := f.writes(t)
	if len(lines) != 4 {
		t.Fatalf("want 4 audit lines, got %+v", lines)
	}
	if l := lines[0]; l.Method != "POST" || l.RecordType != "TXT" || l.RecordName != "_acme-challenge.lan" || l.Content != "token-value" || l.Result != "succeeded" || l.ZoneID != cfZone {
		t.Fatalf("create line: %+v", l)
	}
	if l := lines[3]; l.Method != "DELETE" || l.RecordName != "lan.fixture.invalid" || l.RecordType != "A" || l.RecordID != cfRecord || l.Result != "succeeded" {
		t.Fatalf("delete line does not name the removed record: %+v", l)
	}

	before := len(f.upstreamCalls())
	for _, tc := range []struct{ method, path, body string }{
		{"POST", "/zones/" + cfOtherZone + "/dns_records", `{"type":"A"}`},        // unbound zone
		{"DELETE", "/zones/" + cfZone + "/dns_records", ""},                       // whole collection
		{"POST", "/zones/" + cfZone + "/dns_records/" + cfRecord, `{"type":"A"}`}, // POST to a record
		{"PATCH", "/zones/" + cfZone + "/dns_records/not-an-id", `{"type":"A"}`},
		{"POST", "/zones/" + cfZone + "/dns_records/batch", `{"posts":[]}`},
		{"POST", "/zones/" + cfZone + "/purge_cache", `{"purge_everything":true}`},
		{"PATCH", "/zones/" + cfZone + "/settings/ssl", `{"value":"off"}`},
		{"DELETE", "/zones/" + cfZone, ""},
		{"POST", "/accounts/x/workers/scripts", `{}`},
		{"POST", "/zones/" + cfZone + "/dns_records/../settings", `{}`},
		{"POST", "/zones/" + cfZone + "/dns_records", ""},                           // no body
		{"POST", "/zones/" + cfZone + "/dns_records", `[1]`},                        // not an object
		{"POST", "/zones/" + cfZone + "/dns_records", `{"a":1} {"b":2}`},            // two values
		{"DELETE", "/zones/" + cfZone + "/dns_records/" + cfRecord, `{"type":"A"}`}, // DELETE with a body
		{"OPTIONS", "/zones/" + cfZone + "/dns_records", ""},
	} {
		if _, err := f.request(tc.method, tc.path, tc.body); !errors.Is(err, ErrCloudflareAccess) {
			t.Errorf("%s %s %s: want refusal, got %v", tc.method, tc.path, tc.body, err)
		}
	}
	if got := len(f.upstreamCalls()); got != before {
		t.Fatalf("refused changes reached Cloudflare: %+v", f.upstreamCalls()[before:])
	}
	for _, l := range f.writes(t)[4:] {
		if l.Result != "refused" {
			t.Fatalf("refused attempt logged as %+v", l)
		}
	}
}

func TestCloudflareDNSEditNeedsTheGrantedScopeAndReportsCloudflareErrors(t *testing.T) {
	f := newCFWriteFixture(t, []string{"zone.read", "dns.read"})
	ctx := context.Background()
	// Set while the grant held dns.write, then re-authorized without it.
	if err := f.st.SetExternalAccountBindingAccess(ctx, "workspace-a", f.account.ID, "alice", externalaccounts.CloudflareAccessDNSEdit); err != nil {
		t.Fatal(err)
	}
	_, err := f.request("POST", "/zones/"+cfZone+"/dns_records", `{"type":"A","name":"lan","content":"192.0.2.10"}`)
	if !errors.Is(err, ErrCloudflareAccess) || !strings.Contains(err.Error(), "dns.write") || !strings.Contains(err.Error(), "re-authorizes") {
		t.Fatalf("lost scope not explained: %v", err)
	}
	if len(f.upstreamCalls()) != 0 {
		t.Fatal("change without the scope reached Cloudflare")
	}

	f.account.GrantedScopes = []string{"zone.read", "dns.read", "dns.write"}
	if _, err := f.st.SaveExternalAccount(ctx, f.account); err != nil {
		t.Fatal(err)
	}
	f.failAPI = true
	_, err = f.request("POST", "/zones/"+cfZone+"/dns_records", `{"type":"A","name":"lan","content":"192.0.2.10"}`)
	if err == nil || !strings.Contains(err.Error(), "81057") || !strings.Contains(err.Error(), "identical record") {
		t.Fatalf("Cloudflare's error not passed on: %v", err)
	}
	lines := f.writes(t)
	if last := lines[len(lines)-1]; last.Result != "failed" || !strings.Contains(last.Error, "81057") || last.RecordName != "lan" {
		t.Fatalf("failed change line: %+v", last)
	}

	// Unbinding ends write access at once.
	f.failAPI = false
	if err := f.st.SetWorkspaceExternalAccounts(ctx, "workspace-a", "alice", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.request("DELETE", "/zones/"+cfZone+"/dns_records/"+cfRecord, ""); !errors.Is(err, ErrCloudflareAccess) {
		t.Fatalf("unbound workspace still writes: %v", err)
	}
}

func TestCloudflareBindingKeepsAccessWhenZonesAreSavedAgain(t *testing.T) {
	f := newCFWriteFixture(t, []string{"dns.write"})
	ctx := context.Background()
	if err := f.st.SetExternalAccountBindingAccess(ctx, "workspace-a", f.account.ID, "bob", externalaccounts.CloudflareAccessDNSEdit); !errors.Is(err, store.ErrExternalAccountNotFound) {
		t.Fatalf("another person set the level: %v", err)
	}
	if err := f.st.SetExternalAccountBindingAccess(ctx, "workspace-a", f.account.ID, "alice", externalaccounts.CloudflareAccessDNSEdit); err != nil {
		t.Fatal(err)
	}
	if err := f.st.SetWorkspaceExternalAccounts(ctx, "workspace-a", "alice", []string{f.account.ID}, map[string][]string{f.account.ID: {cfZone, cfOtherZone}}); err != nil {
		t.Fatal(err)
	}
	bindings, err := f.st.ListWorkspaceExternalAccounts(ctx, "workspace-a")
	if err != nil || len(bindings) != 1 || bindings[0].Access != externalaccounts.CloudflareAccessDNSEdit || len(bindings[0].ResourceIDs) != 2 {
		t.Fatalf("level lost on re-save: %+v %v", bindings, err)
	}
	other, err := f.st.ListWorkspaceExternalAccounts(ctx, "workspace-b")
	if err != nil || len(other) != 0 {
		t.Fatalf("level leaked to another workspace: %+v", other)
	}
}
