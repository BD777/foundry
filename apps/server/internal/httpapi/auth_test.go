package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const accountsTestOrigin = "https://foundry.example"

func newAccountsTestServer(t *testing.T) (*Server, http.Handler) {
	t.Helper()
	db, err := sqlitestore.Open(t.TempDir() + "/foundry.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	server := NewServerWithOptions(db, ServerOptions{
		AllowedOrigin: accountsTestOrigin,
		// Registers the conditional dev route so coverage tests see it.
		EnableDevReset: true,
	})
	return server, server.Routes()
}

type authCall struct {
	method  string
	path    string
	body    string
	cookie  string
	origin  string
	headers map[string]string
}

func doAuthCall(t *testing.T, handler http.Handler, call authCall) *httptest.ResponseRecorder {
	t.Helper()
	var body *strings.Reader
	if call.body != "" {
		body = strings.NewReader(call.body)
	} else {
		body = strings.NewReader("")
	}
	request := httptest.NewRequest(call.method, call.path, body)
	if call.body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if call.origin != "" {
		request.Header.Set("Origin", call.origin)
	}
	if call.cookie != "" {
		request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: call.cookie})
	}
	for key, value := range call.headers {
		request.Header.Set(key, value)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func sessionCookieFrom(t *testing.T, recorder *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, cookie := range recorder.Result().Cookies() {
		if cookie.Name == sessionCookieName && cookie.Value != "" {
			return cookie
		}
	}
	t.Fatalf("no session cookie in response %d %s", recorder.Code, recorder.Body.String())
	return nil
}

func expectStatus(t *testing.T, recorder *httptest.ResponseRecorder, want int, label string) {
	t.Helper()
	if recorder.Code != want {
		t.Fatalf("%s: status = %d, want %d; body %s", label, recorder.Code, want, recorder.Body.String())
	}
}

// setupOwner runs first-owner setup and returns the owner session token.
func setupOwner(t *testing.T, server *Server, handler http.Handler) string {
	t.Helper()
	body := `{"setupCode":"` + strings.ToLower(server.SetupCode()) + `","username":"owner","displayName":"Owner","password":"correct horse battery"}`
	recorder := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/auth/setup", body: body, origin: accountsTestOrigin})
	expectStatus(t, recorder, http.StatusCreated, "setup")
	return sessionCookieFrom(t, recorder).Value
}

func inviteAndJoin(t *testing.T, handler http.Handler, ownerSession, role, username string) string {
	t.Helper()
	created := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/invites", body: `{"role":"` + role + `"}`, cookie: ownerSession, origin: accountsTestOrigin})
	expectStatus(t, created, http.StatusCreated, "create invite")
	var invite struct {
		Token string `json:"token"`
		Role  string `json:"role"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &invite); err != nil || invite.Token == "" || invite.Role != role {
		t.Fatalf("invite response %s (%v)", created.Body.String(), err)
	}
	preview := doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/auth/invites/" + invite.Token})
	expectStatus(t, preview, http.StatusOK, "preview invite")
	accepted := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/auth/invites/" + invite.Token + "/accept",
		body: `{"username":"` + username + `","password":"member password 1"}`, origin: accountsTestOrigin})
	expectStatus(t, accepted, http.StatusCreated, "accept invite")
	reused := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/auth/invites/" + invite.Token + "/accept",
		body: `{"username":"` + username + `x","password":"member password 1"}`, origin: accountsTestOrigin})
	expectStatus(t, reused, http.StatusGone, "reuse invite")
	return sessionCookieFrom(t, accepted).Value
}

func TestAccountsModeRequiresLogin(t *testing.T) {
	server, handler := newAccountsTestServer(t)

	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/workspaces"}), http.StatusUnauthorized, "anonymous API call")
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/workspaces", headers: map[string]string{"Authorization": "Bearer made-up"}}),
		http.StatusUnauthorized, "unknown bearer token")
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/workspaces", cookie: "forged"}), http.StatusUnauthorized, "forged cookie")
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/healthz"}), http.StatusOK, "health stays public")

	state := doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/auth/state"})
	expectStatus(t, state, http.StatusOK, "auth state")
	if !strings.Contains(state.Body.String(), `"needsSetup":true`) || strings.Contains(state.Body.String(), `"user"`) {
		t.Fatalf("auth state before setup = %s", state.Body.String())
	}
	if server.SetupCode() == "" {
		t.Fatal("setup code must exist while no user exists")
	}

	// A worker device credential acts as its owner on browser routes (local
	// worker CLI); an unknown one is a hard 401.
	credential := pairTestDevice(t, server, "dev_cli", "machine-cli")
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/workspaces", headers: map[string]string{deviceCredentialHeader: credential}}),
		http.StatusOK, "device credential on browser route")
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/workspaces", headers: map[string]string{deviceCredentialHeader: "forged"}}),
		http.StatusUnauthorized, "forged device credential")
}

func TestAccountsSetupLoginAndLogout(t *testing.T) {
	server, handler := newAccountsTestServer(t)

	wrong := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/auth/setup", origin: accountsTestOrigin,
		body: `{"setupCode":"AAAA-BBBB-CCCC","username":"owner","password":"correct horse battery"}`})
	expectStatus(t, wrong, http.StatusForbidden, "setup with wrong code")
	weak := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/auth/setup", origin: accountsTestOrigin,
		body: `{"setupCode":"` + server.SetupCode() + `","username":"owner","password":"short"}`})
	expectStatus(t, weak, http.StatusBadRequest, "setup with weak password")
	noOrigin := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/auth/setup",
		body: `{"setupCode":"` + server.SetupCode() + `","username":"owner","password":"correct horse battery"}`})
	expectStatus(t, noOrigin, http.StatusForbidden, "setup without Origin")

	session := setupOwner(t, server, handler)
	if server.SetupCode() != "" {
		t.Fatal("setup code must be consumed")
	}
	again := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/auth/setup", origin: accountsTestOrigin,
		body: `{"setupCode":"AAAA-BBBB-CCCC","username":"second","password":"correct horse battery"}`})
	expectStatus(t, again, http.StatusConflict, "second setup")

	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/workspaces", cookie: session}), http.StatusOK, "logged-in read")
	state := doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/auth/state", cookie: session})
	if !strings.Contains(state.Body.String(), `"username":"owner"`) || !strings.Contains(state.Body.String(), `"needsSetup":false`) {
		t.Fatalf("auth state after setup = %s", state.Body.String())
	}

	failed := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/auth/login", origin: accountsTestOrigin,
		body: `{"username":"owner","password":"wrong password!"}`})
	expectStatus(t, failed, http.StatusUnauthorized, "wrong password")
	unknown := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/auth/login", origin: accountsTestOrigin,
		body: `{"username":"nobody","password":"wrong password!"}`})
	if unknown.Code != http.StatusUnauthorized || unknown.Body.String() != failed.Body.String() {
		t.Fatalf("unknown user must look like a wrong password: %d %s", unknown.Code, unknown.Body.String())
	}
	login := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/auth/login", origin: accountsTestOrigin,
		body: `{"username":"OWNER","password":"correct horse battery"}`})
	expectStatus(t, login, http.StatusOK, "login")
	cookie := sessionCookieFrom(t, login)
	if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/" {
		t.Fatalf("session cookie attributes = %+v", cookie)
	}

	logout := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/auth/logout", cookie: cookie.Value, origin: accountsTestOrigin})
	expectStatus(t, logout, http.StatusNoContent, "logout")
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/workspaces", cookie: cookie.Value}), http.StatusUnauthorized, "after logout")
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/workspaces", cookie: session}), http.StatusOK, "other session survives logout")
}

func TestAccountsLoginIsRateLimited(t *testing.T) {
	server, handler := newAccountsTestServer(t)
	setupOwner(t, server, handler)
	server.loginLimiter.lockDuration = time.Hour

	for attempt := 0; attempt < 5; attempt++ {
		failed := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/auth/login", origin: accountsTestOrigin,
			body: `{"username":"owner","password":"wrong password!"}`})
		expectStatus(t, failed, http.StatusUnauthorized, "failed login")
	}
	locked := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/auth/login", origin: accountsTestOrigin,
		body: `{"username":"owner","password":"correct horse battery"}`})
	expectStatus(t, locked, http.StatusTooManyRequests, "locked out even with the right password")

	// httptest peers are 192.0.2.1 (not loopback), so a spoofed X-Real-IP
	// must not escape the lock.
	spoofed := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/auth/login", origin: accountsTestOrigin,
		body: `{"username":"owner","password":"correct horse battery"}`, headers: map[string]string{"X-Real-IP": "198.51.100.7"}})
	expectStatus(t, spoofed, http.StatusTooManyRequests, "X-Real-IP from a non-loopback peer is ignored")
}

func TestClientIPTrustsRealIPOnlyFromLoopback(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	request.Header.Set("X-Real-IP", "198.51.100.7")
	if got := clientIP(request); got != "192.0.2.1" {
		t.Fatalf("remote peer clientIP = %q, want socket address", got)
	}
	request.RemoteAddr = "127.0.0.1:50000"
	if got := clientIP(request); got != "198.51.100.7" {
		t.Fatalf("loopback proxy clientIP = %q, want X-Real-IP", got)
	}
}

func TestAccountsRejectCrossSiteWrites(t *testing.T) {
	server, handler := newAccountsTestServer(t)
	session := setupOwner(t, server, handler)

	body := `{"name":"x"}`
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/chat-layout", body: body, cookie: session}),
		http.StatusForbidden, "cookie write without Origin")
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/chat-layout", body: body, cookie: session, origin: "https://evil.example"}),
		http.StatusForbidden, "cookie write from foreign origin")
	allowed := doAuthCall(t, handler, authCall{method: http.MethodOptions, path: "/api/workspaces", origin: accountsTestOrigin})
	if allowed.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("preflight must allow credentials for the web origin, headers %v", allowed.Header())
	}
}

func TestAccountsPasswordChangeRotatesSessions(t *testing.T) {
	server, handler := newAccountsTestServer(t)
	first := setupOwner(t, server, handler)
	login := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/auth/login", origin: accountsTestOrigin,
		body: `{"username":"owner","password":"correct horse battery"}`})
	second := sessionCookieFrom(t, login).Value

	wrong := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/auth/me/password", cookie: first, origin: accountsTestOrigin,
		body: `{"currentPassword":"not it at all","newPassword":"brand new password"}`})
	expectStatus(t, wrong, http.StatusForbidden, "wrong current password")
	changed := doAuthCall(t, handler, authCall{method: http.MethodPost, path: "/api/auth/me/password", cookie: first, origin: accountsTestOrigin,
		body: `{"currentPassword":"correct horse battery","newPassword":"brand new password"}`})
	expectStatus(t, changed, http.StatusNoContent, "change password")
	fresh := sessionCookieFrom(t, changed).Value

	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/workspaces", cookie: first}), http.StatusUnauthorized, "old session")
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/workspaces", cookie: second}), http.StatusUnauthorized, "other device session")
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/workspaces", cookie: fresh}), http.StatusOK, "new session")
}

func TestLoopbackHasNoAnonymousAccess(t *testing.T) {
	server := NewServerWithOptions(newEmptyTestStore(t), DefaultServerOptions())
	handler := server.Routes()
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/workspaces"}),
		http.StatusUnauthorized, "anonymous loopback read")
	if server.SetupCode() == "" {
		t.Fatal("an empty server must offer first-owner setup")
	}
}

func TestHumanActorAttributesAccount(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/api/issues/x/contracts", nil)
	if got := humanActor(request); got.Kind != "local_owner" {
		t.Fatalf("without an account = %+v, want local_owner", got)
	}
	account := &store.User{ID: "user_1", DisplayName: "Alice", Role: store.RoleMember}
	request = request.WithContext(actorInContext(context.Background(), Actor{Kind: ActorAccount, Account: account}))
	got := humanActor(request)
	if got.Kind != "user" || got.ID != "user_1" || got.DisplayName != "Alice" || !store.IsHumanActor(got) {
		t.Fatalf("with an account = %+v", got)
	}
}
