package externalaccounts_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type cfHarness struct {
	service               *externalaccounts.Service
	store                 *sqlitestore.Store
	adapter               *externalaccounts.Cloudflare
	tokens, registrations atomic.Int32
	clock                 atomic.Int64
	challenge             atomic.Value
	identityFailures      atomic.Int32
}

func newCFHarness(t *testing.T) *cfHarness {
	t.Helper()
	h := &cfHarness{}
	h.clock.Store(time.Now().UnixNano())
	now := func() time.Time { return time.Unix(0, h.clock.Load()) }
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/register":
			h.registrations.Add(1)
			var input map[string]any
			_ = json.NewDecoder(r.Body).Decode(&input)
			if input["token_endpoint_auth_method"] != "none" {
				t.Error("not a public client")
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"client_id": "fixture-public-client", "token_endpoint_auth_method": "none"})
		case "/token":
			_ = r.ParseForm()
			if r.Form.Get("grant_type") == "authorization_code" {
				h.tokens.Add(1)
				sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
				if base64.RawURLEncoding.EncodeToString(sum[:]) != h.challenge.Load() {
					t.Error("PKCE mismatch")
				}
				if r.Form.Get("redirect_uri") != "https://foundry.example/api/connectors/cloudflare/oauth/callback" {
					t.Error("redirect mismatch")
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "cf-access-fixture", "refresh_token": "cf-refresh-fixture", "token_type": "Bearer", "expires_in": 3600, "scope": "offline_access user:read account:read zone.read dns.read ssl-and-certificates.read"})
		case "/mcp":
			if left := h.identityFailures.Load(); left > 0 && h.identityFailures.CompareAndSwap(left, left-1) {
				w.WriteHeader(503)
				return
			}
			if r.Header.Get("Authorization") != "Bearer cf-access-fixture" {
				t.Error("token sent to wrong place or missing")
			}
			var input struct {
				Method string `json:"method"`
				Params struct {
					Name string `json:"name"`
				} `json:"params"`
			}
			_ = json.NewDecoder(r.Body).Decode(&input)
			if input.Method != "tools/call" || input.Params.Name != "whoami" {
				t.Error("unexpected MCP request")
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": map[string]any{"structuredContent": map[string]any{"id": "user:fixture", "email": "fixture@example.invalid"}}})
		default:
			t.Error("unexpected upstream path", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(server.Close)
	st, err := sqlitestore.OpenWithOptions(filepath.Join(t.TempDir(), "db"), sqlitestore.Options{SecretKeyPath: filepath.Join(t.TempDir(), "key")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	h.store = st
	h.adapter = externalaccounts.NewCloudflare()
	h.adapter.BaseURL = server.URL
	h.adapter.Client = server.Client()
	h.adapter.Now = now
	h.service = externalaccounts.NewService(st, st, externalaccounts.NewRegistry(h.adapter))
	h.service.Now = now
	return h
}
func (h *cfHarness) begin(t *testing.T, request string, accountIDs ...string) store.ExternalAccountLogin {
	t.Helper()
	v, err := h.service.BeginAuthorizationCode(context.Background(), "alice", "cloudflare", request, "https://foundry.example/api/connectors/cloudflare/oauth/callback", accountIDs...)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		v, _ = h.service.Login(v.ID, "alice")
		if v.VerificationURI != "" {
			u, _ := url.Parse(v.VerificationURI)
			h.challenge.Store(u.Query().Get("code_challenge"))
			return v
		}
		if v.Status == "failed" {
			t.Fatal(v.Error)
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("no authorization link")
	return v
}
func TestCloudflarePKCEOwnerReplayAndSealedGrant(t *testing.T) {
	h := newCFHarness(t)
	ctx := context.Background()
	v := h.begin(t, "one")
	u, _ := url.Parse(v.VerificationURI)
	if u.Query().Get("state") != v.ID || u.Query().Get("code_challenge_method") != "S256" || u.Query().Get("resource") != h.adapter.BaseURL+"/mcp" {
		t.Fatal("invalid authorization contract")
	}
	again, err := h.service.BeginAuthorizationCode(ctx, "alice", "cloudflare", "one", "https://foundry.example/api/connectors/cloudflare/oauth/callback")
	if err != nil || again.ID != v.ID || h.registrations.Load() != 1 {
		t.Fatal("duplicate begin")
	}
	for _, who := range []struct{ owner, issuer string }{{"bob", h.adapter.BaseURL}, {"alice", ""}, {"alice", "https://wrong.example"}} {
		if h.service.AuthorizationCodeCallbackAllowed(who.owner, v.ID, who.issuer) {
			t.Fatal("foreign callback allowed")
		}
		if h.service.CompleteAuthorizationCode(ctx, who.owner, v.ID, "fixture-code", who.issuer, "") == nil {
			t.Fatal("foreign callback consumed")
		}
	}
	if h.tokens.Load() != 0 {
		t.Fatal("invalid callback reached token exchange")
	}
	if err := h.service.CompleteAuthorizationCode(ctx, "alice", v.ID, "fixture-code", h.adapter.BaseURL, ""); err != nil {
		t.Fatal(err)
	}
	finished := h.completed(t, v.ID)
	if finished.Status != "complete" || finished.Account == nil || finished.Account.OwnerUserID != "alice" || finished.Account.Subject != "user:fixture" {
		t.Fatalf("bad completion: %+v", finished)
	}
	if finished.Account.RefreshExpiresAt != "" {
		t.Fatal("provider did not report refresh expiry; do not invent it")
	}
	raw, _ := json.Marshal(finished)
	if strings.Contains(string(raw), "cf-access-fixture") || strings.Contains(string(raw), "cf-refresh-fixture") {
		t.Fatal("grant escaped")
	}
	grant, err := h.service.LoadGrant(ctx, finished.Account.ID)
	if err != nil || grant.RefreshToken != "cf-refresh-fixture" {
		t.Fatal("grant was not sealed")
	}
	if h.service.CompleteAuthorizationCode(ctx, "alice", v.ID, "fixture-code", h.adapter.BaseURL, "") == nil || h.tokens.Load() != 1 {
		t.Fatal("callback replayed")
	}
	if _, ok := h.service.Login(v.ID, "bob"); ok {
		t.Fatal("other user read operation")
	}
}
func TestCloudflareCancelExpiryAndResourceBindingPreservation(t *testing.T) {
	h := newCFHarness(t)
	ctx := context.Background()
	v := h.begin(t, "cancel")
	if err := h.service.CancelAuthorizationCode("bob", v.ID); err == nil {
		t.Fatal("cross-user cancel")
	}
	if err := h.service.CancelAuthorizationCode("alice", v.ID); err != nil {
		t.Fatal(err)
	}
	if h.service.CompleteAuthorizationCode(ctx, "alice", v.ID, "fixture-code", h.adapter.BaseURL, "") == nil {
		t.Fatal("cancelled callback accepted")
	}
	expired := h.begin(t, "expire")
	h.clock.Add(int64(11 * time.Minute))
	state, _ := h.service.Login(expired.ID, "alice")
	if state.Status != "failed" || state.VerificationURI != "" || h.service.AuthorizationCodeCallbackAllowed("alice", expired.ID, h.adapter.BaseURL) {
		t.Fatal("expired challenge remained usable")
	}
	next := h.begin(t, "good")
	if err := h.service.CompleteAuthorizationCode(ctx, "alice", next.ID, "fixture-code", h.adapter.BaseURL, ""); err != nil {
		t.Fatal(err)
	}
	done := h.completed(t, next.ID)
	cfID := done.Account.ID
	feishu, err := h.store.SaveExternalAccount(ctx, store.ExternalAccount{ID: "fixture-feishu", Provider: "feishu", OwnerUserID: "alice", Mode: store.ExternalCredentialServerHeld, Status: store.ExternalAccountReady})
	if err != nil {
		t.Fatal(err)
	}
	zone := strings.Repeat("a", 32)
	if err := h.store.SetWorkspaceExternalAccounts(ctx, "ws_fixture", "alice", []string{cfID, feishu.ID}, map[string][]string{cfID: {zone}}); err != nil {
		t.Fatal(err)
	}
	if err := h.store.SetWorkspaceExternalAccounts(ctx, "ws_fixture", "alice", []string{cfID, feishu.ID}); err != nil {
		t.Fatal(err)
	}
	bindings, err := h.store.ListWorkspaceExternalAccounts(ctx, "ws_fixture")
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range bindings {
		if b.AccountID == cfID && (len(b.ResourceIDs) != 1 || b.ResourceIDs[0] != zone) {
			t.Fatal("old client erased resources")
		}
	}
	if h.store.SetWorkspaceExternalAccounts(ctx, "ws_other", "alice", []string{cfID}) == nil {
		t.Fatal("new unscoped binding allowed")
	}
	if h.store.SetWorkspaceExternalAccounts(ctx, "ws_fixture", "bob", []string{cfID}, map[string][]string{cfID: {zone}}) == nil {
		t.Fatal("foreign account bound")
	}
}

func (h *cfHarness) completed(t *testing.T, id string) store.ExternalAccountLogin {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		v, _ := h.service.Login(id, "alice")
		if v.Status == "complete" {
			return v
		}
		if v.Status == "failed" {
			t.Fatal(v.Error)
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("verification did not finish")
	return store.ExternalAccountLogin{}
}
func TestCloudflareVerificationRetriesWithoutAnotherGrantAndRevocationWins(t *testing.T) {
	h := newCFHarness(t)
	ctx := context.Background()
	h.identityFailures.Store(1)
	v := h.begin(t, "retry-verification")
	if err := h.service.CompleteAuthorizationCode(ctx, "alice", v.ID, "fixture-code", h.adapter.BaseURL, ""); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		state, _ := h.service.Login(v.ID, "alice")
		if state.Error != "" {
			break
		}
		time.Sleep(time.Millisecond)
	}
	h.clock.Add(int64(4 * time.Second))
	done := h.completed(t, v.ID)
	if h.tokens.Load() != 1 {
		t.Fatal("verification repeated authorization")
	}
	h.identityFailures.Store(1)
	pending := h.begin(t, "reauth", done.Account.ID)
	if err := h.service.CompleteAuthorizationCode(ctx, "alice", pending.ID, "fixture-code", h.adapter.BaseURL, ""); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		state, _ := h.service.Login(pending.ID, "alice")
		if state.Error != "" {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if _, err := h.service.Revoke(ctx, *done.Account, "alice"); err != nil {
		t.Fatal(err)
	}
	h.clock.Add(int64(4 * time.Second))
	state, _ := h.service.Login(pending.ID, "alice")
	if state.Status != "failed" {
		t.Fatal("revoked operation resumed")
	}
	account, err := h.store.GetExternalAccount(ctx, done.Account.ID)
	if err != nil || account.Status != store.ExternalAccountRevoked {
		t.Fatal("late authorization resurrected account")
	}
}

func TestCloudflarePendingAdoptionRejectsStaleClose(t *testing.T) {
	h := newCFHarness(t)
	old := h.begin(t, "original-dialog")
	adopted := h.begin(t, "replacement-dialog")
	if old.ID != adopted.ID || h.registrations.Load() != 1 {
		t.Fatal("adoption duplicated provider grant")
	}
	if err := h.service.CancelAuthorizationCode("alice", old.ID, "original-dialog"); err == nil {
		t.Fatal("late close cancelled adopted operation")
	}
	if !h.service.AuthorizationCodeCallbackAllowed("alice", adopted.ID, h.adapter.BaseURL) {
		t.Fatal("adopted operation lost callback")
	}
	if err := h.service.CancelAuthorizationCode("alice", adopted.ID, "replacement-dialog"); err != nil {
		t.Fatal(err)
	}
	if h.service.AuthorizationCodeCallbackAllowed("alice", adopted.ID, h.adapter.BaseURL) {
		t.Fatal("closed callback accepted")
	}
}
