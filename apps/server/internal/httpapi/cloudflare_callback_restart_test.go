package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// DEV-091: a sign-in started before a server handoff completes after it, a
// callback that matches nothing gets the explained page instead of the
// provenance JSON, and the provenance rule is otherwise unchanged.
func TestCloudflareCallbackAcrossRestartAndStaleStates(t *testing.T) {
	f := newExternalAccountsFixture(t)
	var exchanges atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/register":
			fmt.Fprint(w, `{"client_id":"fixture-public","token_endpoint_auth_method":"none"}`)
		case "/token":
			exchanges.Add(1)
			fmt.Fprint(w, `{"access_token":"fixture-access","refresh_token":"fixture-refresh","token_type":"Bearer","expires_in":3600}`)
		case "/mcp":
			fmt.Fprint(w, `{"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"id":"user:fixture-restart","email":"fixture@example.invalid"}}}`)
		default:
			w.WriteHeader(404)
		}
	}))
	defer provider.Close()
	adapter := externalaccounts.NewCloudflare()
	adapter.BaseURL = provider.URL
	adapter.Client = provider.Client()
	process := func() *externalaccounts.Service {
		service := externalaccounts.NewService(f.db, f.db, externalaccounts.NewRegistry(adapter))
		f.server.connectors.ServerHeld = service
		f.server.connectors.Cloudflare = connectors.NewCloudflareGateway(f.db, service)
		return service
	}
	first := process()
	start := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/connectors/cloudflare/sign-in", `{"requestId":"dialog-restart"}`))
	expectStatus(t, start, 202, "begin")
	var login store.ExternalAccountLogin
	_ = json.Unmarshal(start.Body.Bytes(), &login)
	waitFor(t, "authorization link", func() bool { login, _ = first.Login(login.ID, f.aliceID); return login.VerificationURI != "" })
	f.server.options.PreviewSameSite = true

	navigate := func(cookie, path, mode, language string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", accountsTestOrigin+path, nil)
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: f.server.accountCookieName(), Value: cookie})
		}
		req.Header.Set("Sec-Fetch-Site", "cross-site")
		req.Header.Set("Sec-Fetch-Mode", mode)
		req.Header.Set("Sec-Fetch-Dest", map[string]string{"navigate": "document", "cors": "empty"}[mode])
		if language != "" {
			req.Header.Set("Accept-Language", language)
		}
		w := httptest.NewRecorder()
		f.server.Routes().ServeHTTP(w, req)
		return w
	}
	callback := func(state string) string {
		return cloudflareOAuthCallbackPath + "?" + url.Values{"state": {state}, "code": {"fixture-code"}, "iss": {provider.URL}}.Encode()
	}
	page := func(w *httptest.ResponseRecorder, status int, want string) {
		t.Helper()
		body := w.Body.String()
		if w.Code != status || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/html") || !strings.Contains(body, want) ||
			!strings.Contains(body, `href="/connectors/cloudflare"`) || strings.Contains(body, "provenance") || strings.Contains(body, "fixture-code") {
			t.Fatalf("callback page = %d %q, want %d with %q", w.Code, body, status, want)
		}
	}

	// Stale states before the handoff, while nothing is claimed.
	page(navigate(f.alice, callback("xlogin_"+strings.Repeat("0", 8)), "navigate", ""), 403, "no record of this authorization")
	page(navigate(f.alice, callback("xlogin_"+strings.Repeat("0", 8)), "navigate", "zh-CN,zh;q=0.9"), 403, "没有这次授权的记录")
	page(navigate(f.bob, callback(login.ID), "navigate", ""), 403, "belongs to another Foundry account")
	page(navigate("", callback(login.ID), "navigate", ""), 401, "Sign in to Foundry first")
	page(navigate(f.alice, callback(login.ID), "cors", ""), 403, "did not confirm this return")

	// The provenance rule for every other route is unchanged.
	for _, path := range []string{"/api/auth/state", "/api/connectors/devices", "/api/connectors/cloudflare/logins/" + login.ID} {
		refused := navigate(f.alice, path, "navigate", "")
		if refused.Code != 403 || !strings.Contains(refused.Body.String(), "browser provenance required") {
			t.Fatalf("%s: provenance answer changed: %d %s", path, refused.Code, refused.Body.String())
		}
	}

	// The handoff: a new process with nothing in memory takes the callback.
	second := process()
	page(navigate(f.alice, callback(login.ID), "navigate", ""), 200, "Cloudflare authorization received")
	waitFor(t, "connected after the handoff", func() bool { view, _ := second.Login(login.ID, f.aliceID); return view.Status == "complete" })
	page(navigate(f.alice, callback(login.ID), "navigate", ""), 403, "already used")
	process()
	page(navigate(f.alice, callback(login.ID), "navigate", ""), 403, "already used")
	if exchanges.Load() != 1 {
		t.Fatalf("code exchanged %d times", exchanges.Load())
	}
	// The dialog reading its sign-in after another restart sees how it ended.
	f.server.options.PreviewSameSite = false
	read := doAuthCall(t, f.handler, f.as(f.alice, "GET", "/api/external-accounts/logins/"+login.ID, ""))
	expectStatus(t, read, 200, "login after restart")
	var ended store.ExternalAccountLogin
	_ = json.Unmarshal(read.Body.Bytes(), &ended)
	if ended.Status != "complete" || ended.Account == nil {
		t.Fatalf("login after restart %+v", ended)
	}

	// Closing a sign-in that no longer exists tells the dialog it is gone.
	gone := doAuthCall(t, f.handler, f.as(f.alice, "DELETE", "/api/connectors/cloudflare/logins/xlogin_missing", `{"requestId":"dialog-restart"}`))
	if gone.Code != 200 || !strings.Contains(gone.Body.String(), `"status":"gone"`) {
		t.Fatalf("cancel a missing sign-in: %d %s", gone.Code, gone.Body.String())
	}
	// Finished in an earlier process: nothing is left to close either.
	finished := doAuthCall(t, f.handler, f.as(f.alice, "DELETE", "/api/connectors/cloudflare/logins/"+login.ID, `{"requestId":"dialog-restart"}`))
	if finished.Code != 200 || !strings.Contains(finished.Body.String(), `"status":"gone"`) {
		t.Fatalf("cancel a sign-in finished before the restart: %d %s", finished.Code, finished.Body.String())
	}
	other := process()
	pending, err := other.BeginAuthorizationCode(context.Background(), f.aliceID, "cloudflare", "dialog-two", accountsTestOrigin+cloudflareOAuthCallbackPath)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "second link", func() bool { pending, _ = other.Login(pending.ID, f.aliceID); return pending.VerificationURI != "" })
	process()
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, "DELETE", "/api/connectors/cloudflare/logins/"+pending.ID, `{"requestId":"dialog-two"}`)), 204, "close a sign-in an earlier process started")
	f.server.options.PreviewSameSite = true
	page(navigate(f.alice, callback(pending.ID), "navigate", ""), 403, "was closed")
}

// TestCloudflareCallbackRestartBrowserFixture serves a TLS origin for a real
// browser when DEV091_CALLBACK_FIXTURE names a directory: the browser starts
// a sign-in, the synthetic provider page (another site) "restarts" the
// server (a fresh service over the same database, nothing in memory), and
// the browser follows the return link. Synthetic identities only.
func TestCloudflareCallbackRestartBrowserFixture(t *testing.T) {
	directory := os.Getenv("DEV091_CALLBACK_FIXTURE")
	if directory == "" {
		t.Skip("DEV091_CALLBACK_FIXTURE is not set")
	}
	f := newExternalAccountsFixture(t)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/register":
			fmt.Fprint(w, `{"client_id":"fixture-public","token_endpoint_auth_method":"none"}`)
		case "/token":
			fmt.Fprint(w, `{"access_token":"fixture-access","refresh_token":"fixture-refresh","token_type":"Bearer","expires_in":3600}`)
		case "/mcp":
			fmt.Fprint(w, `{"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"id":"user:fixture-browser","email":"fixture@example.invalid"}}}`)
		default:
			w.WriteHeader(404)
		}
	}))
	defer provider.Close()
	adapter := externalaccounts.NewCloudflare()
	adapter.BaseURL = provider.URL
	adapter.Client = provider.Client()
	var restarts atomic.Int32
	process := func() *externalaccounts.Service {
		service := externalaccounts.NewService(f.db, f.db, externalaccounts.NewRegistry(adapter))
		f.server.connectors.ServerHeld = service
		f.server.connectors.Cloudflare = connectors.NewCloudflareGateway(f.db, service)
		return service
	}
	process()
	f.server.options.PreviewSameSite = true
	var origin string
	providerPage := func(w http.ResponseWriter, destination string) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprintf(w, `<!doctype html><title>Synthetic provider</title><p>Server restarted %d time(s).</p><a href="%s">Return synthetic approval</a>`, restarts.Load(), html.EscapeString(destination))
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		issuerOrigin := strings.Replace(origin, "127.0.0.1", "localhost", 1)
		switch r.URL.Path {
		case "/fixture/login":
			f.server.setSessionCookie(w, f.alice, time.Now().Add(time.Hour))
			http.Redirect(w, r, "/fixture", 303)
		case "/fixture":
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, `<!doctype html><title>Cloudflare restart fixture</title><a href="/fixture/start">Start synthetic authorization</a> <a href="/fixture/stale">Return with a stale state</a>`)
		case "/fixture/start":
			service := f.server.connectors.ServerHeld
			login, err := service.BeginAuthorizationCode(r.Context(), f.aliceID, "cloudflare", uuid.NewString(), origin+cloudflareOAuthCallbackPath)
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			deadline := time.Now().Add(5 * time.Second)
			for login.VerificationURI == "" && time.Now().Before(deadline) {
				time.Sleep(20 * time.Millisecond)
				login, _ = service.Login(login.ID, f.aliceID)
			}
			destination := origin + cloudflareOAuthCallbackPath + "?" + url.Values{"state": {login.ID}, "code": {"fixture-code"}, "iss": {provider.URL}}.Encode()
			http.Redirect(w, r, issuerOrigin+"/fixture/provider?return="+url.QueryEscape(destination), 303)
		case "/fixture/stale":
			destination := origin + cloudflareOAuthCallbackPath + "?" + url.Values{"state": {"xlogin_" + uuid.NewString()}, "code": {"fixture-code"}, "iss": {provider.URL}}.Encode()
			http.Redirect(w, r, issuerOrigin+"/fixture/provider?return="+url.QueryEscape(destination), 303)
		case "/fixture/provider":
			// The handoff happens while the person is on the provider's page.
			process()
			restarts.Add(1)
			providerPage(w, r.URL.Query().Get("return"))
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
