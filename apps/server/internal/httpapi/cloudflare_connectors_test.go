package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"html"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestCloudflareHTTPBrowserCallbackOwnerAndBinding(t *testing.T) {
	f := newExternalAccountsFixture(t)
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/register":
			_ = json.NewEncoder(w).Encode(map[string]any{"client_id": "fixture-client", "token_endpoint_auth_method": "none"})
		case "/token":
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "fixture-access", "refresh_token": "fixture-refresh", "token_type": "Bearer", "expires_in": 3600, "scope": "user:read account:read zone.read dns.read ssl-and-certificates.read offline_access"})
		case "/mcp":
			var input struct {
				Params struct {
					Name string `json:"name"`
				} `json:"params"`
			}
			_ = json.NewDecoder(r.Body).Decode(&input)
			var result any
			if input.Params.Name == "whoami" {
				result = map[string]any{"structuredContent": map[string]any{"id": "user:fixture-cf", "email": "cf-user@example.invalid"}}
			} else {
				body, _ := json.Marshal(map[string]any{"success": true, "result": []any{map[string]any{"id": strings.Repeat("a", 32), "name": "fixture.invalid", "account": map[string]string{"id": strings.Repeat("b", 32), "name": "CF account"}}}})
				result = map[string]any{"content": []any{map[string]any{"type": "text", "text": string(body)}}}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": result})
		default:
			t.Error("unexpected path", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer fake.Close()
	adapter := externalaccounts.NewCloudflare()
	adapter.BaseURL = fake.URL
	adapter.Client = fake.Client()
	service := externalaccounts.NewService(f.db, f.db, externalaccounts.NewRegistry(adapter))
	f.server.connectors.ServerHeld = service
	f.server.connectors.Cloudflare = connectors.NewCloudflareGateway(f.db, service)
	f.server.connectors.SetGatewayIssuer(f.server.feishuGateway)
	start := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/connectors/cloudflare/sign-in", `{"requestId":"browser-one"}`))
	expectStatus(t, start, 202, "begin")
	var login store.ExternalAccountLogin
	_ = json.Unmarshal(start.Body.Bytes(), &login)
	if login.ID == "" || login.Status != "pending" {
		t.Fatal("missing receipt")
	}
	waitFor(t, "authorization URL", func() bool {
		var ok bool
		login, ok = service.Login(login.ID, f.aliceID)
		return ok && login.VerificationURI != ""
	})
	u, _ := url.Parse(login.VerificationURI)
	if u.Query().Get("redirect_uri") != accountsTestOrigin+cloudflareOAuthCallbackPath {
		t.Fatal("untrusted redirect")
	}
	callback := cloudflareOAuthCallbackPath + "?" + url.Values{"state": {login.ID}, "code": {"fixture-code"}, "iss": {fake.URL}}.Encode()
	for _, owner := range []string{f.bob} {
		expectStatus(t, doAuthCall(t, f.handler, f.as(owner, "GET", callback, "")), 400, "wrong owner")
	}
	missingIssuer := cloudflareOAuthCallbackPath + "?" + url.Values{"state": {login.ID}, "code": {"fixture-code"}}.Encode()
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, "GET", missingIssuer, "")), 400, "missing issuer")
	accepted := doAuthCall(t, f.handler, f.as(f.alice, "GET", callback, ""))
	expectStatus(t, accepted, 200, "callback")
	if accepted.Header().Get("Referrer-Policy") != "no-referrer" || strings.Contains(accepted.Body.String(), "fixture-access") {
		t.Fatal("callback leaked credential")
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, "GET", callback, "")), 400, "replay")
	var done store.ExternalAccountLogin
	waitFor(t, "saved Cloudflare identity", func() bool { done, _ = service.Login(login.ID, f.aliceID); return done.Status == "complete" })
	if done.Account == nil || done.Status != "complete" {
		t.Fatalf("not connected %+v", done)
	}
	accountID := done.Account.ID
	zones := doAuthCall(t, f.handler, f.as(f.alice, "GET", "/api/connectors/cloudflare/accounts/"+accountID+"/zones", ""))
	expectStatus(t, zones, 200, "zones")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.bob, "GET", "/api/connectors/cloudflare/accounts/"+accountID+"/zones", "")), 404, "other user zones")
	body, _ := json.Marshal(map[string]any{"accountIds": []string{accountID}, "resources": map[string][]string{accountID: {strings.Repeat("a", 32)}}})
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, "PUT", "/api/workspaces/ws_alice/external-accounts", string(body))), 200, "bind own zones")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.bob, "PUT", "/api/workspaces/ws_bob/external-accounts", string(body))), 404, "cross-user bind")
	ctx := context.Background()
	active, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice", Provider: "claude", Prompt: "read selected Cloudflare zone", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	actor := Actor{Kind: ActorAgent, Identity: store.SessionTokenIdentity{SessionID: active.ID, WorkspaceID: active.WorkspaceID}}
	if err := f.server.cloudflareToolAvailable(ctx, actor); err != nil {
		t.Fatal("bound tool unavailable", err)
	}
	if err := f.server.cloudflareToolAvailable(ctx, Actor{Kind: ActorAccount}); err == nil {
		t.Fatal("tool exposed outside a session")
	}
	renewBody, _ := json.Marshal(map[string]string{"sessionId": active.ID, "accountId": accountID})
	renewed := doAuthCall(t, f.handler, deviceCall("POST", "/api/connectors/cloudflare/session-handle", string(renewBody), f.aliceDevice))
	expectStatus(t, renewed, 200, "session handle")
	var handle store.ExternalAccountGateway
	_ = json.Unmarshal(renewed.Body.Bytes(), &handle)
	if !strings.HasPrefix(handle.UserHandle, "fdycf_user_") {
		t.Fatal("missing scoped handle")
	}
	bad := deviceCall("GET", "/api/connectors/cloudflare/gateway/client/v4/zones/"+strings.Repeat("c", 32), "", f.aliceDevice)
	bad.headers["Authorization"] = "Bearer " + handle.UserHandle
	expectStatus(t, doAuthCall(t, f.handler, bad), 403, "unbound zone")
	expectStatus(t, doAuthCall(t, f.handler, deviceCall("POST", "/api/connectors/cloudflare/session-handle", string(renewBody), f.bobDevice)), 403, "other device handle")
	if err := f.db.SetWorkspaceExternalAccounts(ctx, "ws_alice", f.aliceID, nil); err != nil {
		t.Fatal(err)
	}
	if err := f.server.cloudflareToolAvailable(ctx, actor); err == nil {
		t.Fatal("unbound tool stayed visible")
	}

}

// The fixture uses only synthetic identities and an isolated database/provider.
// Its optional TLS listener exercises a real browser's cross-site navigation.
func TestCloudflareSameSiteCallback(t *testing.T) {
	f := newExternalAccountsFixture(t)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/register":
			fmt.Fprint(w, `{"client_id":"fixture-public","token_endpoint_auth_method":"none"}`)
		case "/token":
			fmt.Fprint(w, `{"access_token":"fixture-access","refresh_token":"fixture-refresh","token_type":"Bearer","expires_in":3600}`)
		case "/mcp":
			fmt.Fprint(w, `{"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"id":"user:fixture-callback","email":"fixture@example.invalid"}}}`)
		default:
			w.WriteHeader(404)
		}
	}))
	defer provider.Close()
	adapter := externalaccounts.NewCloudflare()
	adapter.BaseURL = provider.URL
	adapter.Client = provider.Client()
	service := externalaccounts.NewService(f.db, f.db, externalaccounts.NewRegistry(adapter))
	f.server.connectors.ServerHeld = service
	f.server.options.PreviewSameSite = true
	begin := func() store.ExternalAccountLogin {
		login, err := service.BeginAuthorizationCode(context.Background(), f.aliceID, "cloudflare", uuid.NewString(), f.server.options.AllowedOrigin+cloudflareOAuthCallbackPath)
		if err != nil {
			t.Fatal(err)
		}
		waitFor(t, "callback ready", func() bool { login, _ = service.Login(login.ID, f.aliceID); return login.VerificationURI != "" })
		return login
	}
	callback := func(id, issuer string) string {
		return cloudflareOAuthCallbackPath + "?" + url.Values{"state": {id}, "code": {"fixture-code"}, "iss": {issuer}}.Encode()
	}
	login := begin()
	call := func(cookie, path, mode, dest string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", accountsTestOrigin+path, nil)
		req.AddCookie(&http.Cookie{Name: f.server.accountCookieName(), Value: cookie})
		req.Header.Set("Sec-Fetch-Site", "cross-site")
		req.Header.Set("Sec-Fetch-Mode", mode)
		req.Header.Set("Sec-Fetch-Dest", dest)
		w := httptest.NewRecorder()
		f.server.Routes().ServeHTTP(w, req)
		return w
	}
	for _, tc := range []struct{ cookie, path, mode, dest string }{{f.bob, callback(login.ID, provider.URL), "navigate", "document"}, {f.alice, callback(login.ID, ""), "navigate", "document"}, {f.alice, callback(login.ID, "https://wrong.invalid"), "navigate", "document"}, {f.alice, callback(login.ID, provider.URL), "cors", "empty"}, {f.alice, "/api/auth/state", "navigate", "document"}} {
		expectStatus(t, call(tc.cookie, tc.path, tc.mode, tc.dest), 403, "narrow callback exception")
	}
	expectStatus(t, call(f.alice, callback(login.ID, provider.URL), "navigate", "document"), 200, "authorized top-level navigation")
	expectStatus(t, call(f.alice, callback(login.ID, provider.URL), "navigate", "document"), 403, "consumed state")
	waitFor(t, "identity persisted", func() bool { view, _ := service.Login(login.ID, f.aliceID); return view.Status == "complete" })
	directory := os.Getenv("DEV035_CALLBACK_FIXTURE")
	if directory == "" {
		return
	}
	var origin string
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/fixture/login":
			user := f.alice
			if r.URL.Query().Get("as") == "bob" {
				user = f.bob
			}
			f.server.setSessionCookie(w, user, time.Now().Add(time.Hour))
			http.Redirect(w, r, "/fixture", 303)
		case "/fixture":
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, `<!doctype html><title>Cloudflare callback fixture</title><a href="/fixture/start">Start synthetic authorization</a>`)
		case "/fixture/start":
			fresh := begin()
			destination := origin + callback(fresh.ID, provider.URL)
			issuerOrigin := strings.Replace(origin, "127.0.0.1", "localhost", 1)
			http.Redirect(w, r, issuerOrigin+"/fixture/provider?return="+url.QueryEscape(destination), 303)
		case "/fixture/provider":
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprintf(w, `<!doctype html><title>Synthetic provider</title><a href="%s">Return synthetic approval</a>`, html.EscapeString(r.URL.Query().Get("return")))
		default:
			f.server.Routes().ServeHTTP(w, r)
		}
	})
	browser := httptest.NewTLSServer(handler)
	defer browser.Close()
	origin = browser.URL
	f.server.options.AllowedOrigin = origin
	if err := os.WriteFile(filepath.Join(directory, "callback-origin.txt"), []byte(origin), 0600); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Minute)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(filepath.Join(directory, "callback-stop")); err == nil {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("browser fixture timed out")
}
