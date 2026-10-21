package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/accounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func sameSiteFixture(t *testing.T) *tunnelFixture {
	f := newTunnelFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "private application") }))
	f.s.options.PreviewSameSite = true
	f.s.options.PreviewDomain = "foundry.example"
	return f
}
func siteRequest(f *tunnelFixture, method, path, body, cookie string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, f.s.options.AllowedOrigin+path, strings.NewReader(body))
	if cookie != "" {
		r.Header.Set("Cookie", cookie)
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	f.s.Routes().ServeHTTP(w, r)
	return w
}
func TestServiceTunnelSameSiteControlCookieAndProvenance(t *testing.T) {
	f := sameSiteFixture(t)
	path := "/api/workspaces/ws_tunnel/service-tunnels"
	good := f.s.accountCookieName() + "=" + f.session
	h := map[string]string{"Sec-Fetch-Site": "same-origin"}
	expectStatus(t, siteRequest(f, "GET", path, "", good, h), 200, "same-origin account read")
	expectStatus(t, siteRequest(f, "GET", path, "", sessionCookieName+"="+f.session, h), 401, "legacy cookie ignored")
	for _, headers := range []map[string]string{nil, {"Origin": "null"}, {"Origin": "https://evil.foundry.example"}, {"Sec-Fetch-Site": "same-site"}, {"Sec-Fetch-Site": "same-site", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate"}} {
		expectStatus(t, siteRequest(f, "GET", path, "", good, headers), 403, "untrusted provenance")
		expectStatus(t, siteRequest(f, "GET", "/api/auth/state", "", good, headers), 403, "public auth state cannot bypass cookie provenance")
	}
	expectStatus(t, siteRequest(f, "GET", path, "", "", h), 401, "forged metadata is not credentials")
	expectStatus(t, siteRequest(f, "GET", path, "", good, map[string]string{"Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}), 200, "address bar navigation")
	expectStatus(t, siteRequest(f, "GET", "/api/events", "", good, map[string]string{"Upgrade": "websocket", "Sec-Fetch-Site": "same-origin"}), 403, "cookie WebSocket needs Origin")
	w := httptest.NewRecorder()
	f.s.setSessionCookie(w, "synthetic", time.Now().Add(time.Hour))
	found := false
	for _, c := range w.Result().Cookies() {
		if c.Name == "__Host-foundry_session" {
			found = true
			if !c.Secure || !c.HttpOnly || c.Path != "/" || c.Domain != "" {
				t.Fatal("unsafe control cookie")
			}
		}
	}
	if !found {
		t.Fatal("host cookie missing")
	}
}
func TestServiceTunnelSameSiteAllControlGETRoutesRejectSiblingCookie(t *testing.T) {
	f := sameSiteFixture(t)
	count := 0
	pattern := regexp.MustCompile(`\{[^}]+\}`)
	for _, route := range f.s.routeTable() {
		if !strings.HasPrefix(route.pattern, "GET /api/") || strings.HasPrefix(route.pattern, "GET /api/daemon/") {
			continue
		}
		path := pattern.ReplaceAllString(strings.TrimPrefix(route.pattern, "GET "), "synthetic")
		w := siteRequest(f, "GET", path, "", f.s.accountCookieName()+"="+f.session, map[string]string{"Sec-Fetch-Site": "same-site"})
		if w.Code != 403 {
			t.Errorf("sibling cookie reached GET handler %s: %d", path, w.Code)
		}
		count++
	}
	if count < 70 {
		t.Fatal("route audit unexpectedly omitted control reads")
	}
}
func TestServiceTunnelSameSiteHostsAndApplicationExchange(t *testing.T) {
	f := sameSiteFixture(t)
	for _, host := range []string{"unknown.foundry.example", "evil." + workspaceServiceHost(f.tunnel.WorkspaceID) + ".foundry.example", "foundry.example.evil.test", "foundry.example:444", "127.0.0.1"} {
		r := httptest.NewRequest("GET", "https://"+host+"/api/auth/state", nil)
		r.AddCookie(&http.Cookie{Name: f.s.accountCookieName(), Value: f.session})
		w := httptest.NewRecorder()
		f.s.Routes().ServeHTTP(w, r)
		expectStatus(t, w, 404, "unknown host never enters control router")
	}
	cookie := f.grant(t)
	response := f.request(t, "GET", "/", nil, cookie)
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("private same-site stream failed: %d", response.StatusCode)
	}
	w := siteRequest(f, "GET", "/api/auth/state", "", f.s.accountCookieName()+"="+f.session, map[string]string{"Sec-Fetch-Site": "same-origin"})
	if w.Header().Get("Origin-Agent-Cluster") != "?1" || w.Header().Get("Cross-Origin-Opener-Policy") != "same-origin" || !strings.Contains(w.Header().Get("Permissions-Policy"), "document-domain=()") {
		t.Fatal("control origin lacks isolation headers")
	}
}
func TestServiceTunnelHostIdentityStableOnRenameAndRetry(t *testing.T) {
	f := sameSiteFixture(t)
	ctx := context.Background()
	u, _ := f.s.store.GetUser(ctx, f.userID)
	a := Actor{Kind: ActorAccount, Account: &u}
	input := serviceTunnelInput{Name: "Autorun", Port: 18082, Protocol: "http", Visibility: "private", Enabled: true, RegistrationKey: "retry"}
	first, err := f.s.saveServiceTunnel(ctx, a, f.tunnel.WorkspaceID, "", input)
	if err != nil {
		t.Fatal(err)
	}
	again, err := f.s.saveServiceTunnel(ctx, a, f.tunnel.WorkspaceID, "", input)
	if err != nil || first.HostLabel != again.HostLabel {
		t.Fatal("retry moved origin")
	}
	oldURL := f.s.tunnelURL(first)
	input.Name = "Renamed application"
	input.Visibility = "workspace"
	input.ExpectedRevision = 1
	updated, err := f.s.saveServiceTunnel(ctx, a, f.tunnel.WorkspaceID, first.ID, input)
	if err != nil || f.s.tunnelURL(updated) != oldURL {
		t.Fatal("rename/share moved origin", err)
	}
	if !strings.Contains(oldURL, "."+workspaceServiceHost(f.tunnel.WorkspaceID)+".") {
		t.Fatal("project workspace not in host")
	}
	copy := updated
	copy.DeviceID = "other"
	copy.TargetWorkspaceID = "other"
	if f.s.tunnelURL(copy) != oldURL {
		t.Fatal("execution location determines hostname")
	}
	if newServiceHostLabel("Autorun") == newServiceHostLabel("Autorun") {
		t.Fatal("origin reused")
	}
	if workspaceServiceHost("ws_c32d4f0d-0c95-43db-a35c-addbd01e9047") != "ws-c32d4f0d0c9543dba35caddbd01e9047" {
		t.Fatal("workspace UUID identity changed")
	}
}
func TestServiceTunnelSameSiteLogoutRevokesGrant(t *testing.T) {
	f := sameSiteFixture(t)
	cookie := f.grant(t)
	w := siteRequest(f, "POST", "/api/auth/logout", "", f.s.accountCookieName()+"="+f.session, map[string]string{"Origin": f.s.options.AllowedOrigin})
	expectStatus(t, w, 204, "logout")
	if _, _, err := f.s.store.ResolveUserSession(context.Background(), accounts.HashToken(f.session), time.Now(), time.Time{}, time.Time{}); err == nil {
		t.Fatal("login survived logout")
	}
	r := f.request(t, "GET", "/", nil, cookie)
	defer r.Body.Close()
	if r.StatusCode != 403 {
		t.Fatal("preview survived logout")
	}
}

func TestServiceTunnelRetargetKeepsOriginAndRevokesPreviousGrant(t *testing.T) {
	f := sameSiteFixture(t)
	cookie := f.grant(t)
	ctx := context.Background()
	u, _ := f.s.store.GetUser(ctx, f.userID)
	input := serviceTunnelInput{Name: f.tunnel.Name, Port: 18082, Protocol: "http", Visibility: "private", Enabled: true, ExpectedRevision: 1}
	updated, err := f.s.saveServiceTunnel(ctx, Actor{Kind: ActorAccount, Account: &u}, f.tunnel.WorkspaceID, f.tunnel.ID, input)
	if err != nil || f.s.tunnelURL(updated) != f.s.tunnelURL(f.tunnel) || updated.Revision != 2 {
		t.Fatal("explicit retarget moved origin or lost revision", err)
	}
	response := f.request(t, "GET", "/", nil, cookie)
	defer response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatalf("old deployment grant survived retarget: %d", response.StatusCode)
	}
}

func TestServiceTunnelSharedApplicationCookiesStayWithFoundryLogin(t *testing.T) {
	f := newTunnelFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/set" {
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "upstream-owner", Path: "/"})
		}
		fmt.Fprint(w, r.Header.Get("Cookie"))
	}))
	f.s.options.PreviewSameSite = true
	f.s.options.PreviewDomain = "foundry.example"
	f.tunnel.Visibility = "workspace"
	f.tunnel.Revision++
	if err := f.s.store.(store.ServiceTunnelStore).UpdateServiceTunnel(context.Background(), f.tunnel, 1); err != nil {
		t.Fatal(err)
	}
	ownerGrant := f.grant(t)
	response := f.request(t, "GET", "/set", nil, ownerGrant)
	ownerCookies := response.Cookies()
	response.Body.Close()
	if len(ownerCookies) != 1 {
		t.Fatal("owner app cookie missing")
	}
	other, err := f.s.store.CreateUser(context.Background(), store.NewUser{Username: "shared-other", Role: store.RoleMember})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.s.store.SetWorkspaceMember(context.Background(), f.tunnel.WorkspaceID, other.ID, store.WorkspaceRoleMember, f.userID); err != nil {
		t.Fatal(err)
	}
	f.session = tunnelRandom()
	if err = f.s.store.CreateUserSession(context.Background(), other.ID, accounts.HashToken(f.session), time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	otherGrant := f.grant(t)
	request := httptest.NewRequest("GET", f.s.tunnelURL(f.tunnel)+"/echo", nil)
	request.AddCookie(otherGrant)
	request.AddCookie(ownerCookies[0])
	record := httptest.NewRecorder()
	f.s.Routes().ServeHTTP(record, request)
	expectStatus(t, record, 200, "shared mapping access")
	if record.Body.Len() != 0 {
		t.Fatal("other Foundry login inherited upstream cookie", record.Body.String())
	}
	response = f.request(t, "GET", "/set", nil, otherGrant)
	otherCookies := response.Cookies()
	response.Body.Close()
	if len(otherCookies) != 1 || otherCookies[0].Name == ownerCookies[0].Name {
		t.Fatal("application cookie namespace did not change")
	}
	request = httptest.NewRequest("GET", f.s.tunnelURL(f.tunnel)+"/echo", nil)
	request.AddCookie(otherGrant)
	request.AddCookie(otherCookies[0])
	record = httptest.NewRecorder()
	f.s.Routes().ServeHTTP(record, request)
	expectStatus(t, record, 200, "current login cookie")
	if record.Body.String() != "session=upstream-owner" {
		t.Fatal("current login app cookie not restored")
	}
	request.AddCookie(ownerCookies[0])
	clear := httptest.NewRecorder()
	clearOtherAppCookieAudiences(clear, request, previewAppCookieAudience(previewGrant{TunnelID: f.tunnel.ID, SessionHash: accounts.HashToken(f.session)}))
	expired := clear.Result().Cookies()
	if len(expired) != 1 || expired[0].Name != ownerCookies[0].Name || expired[0].MaxAge >= 0 {
		t.Fatal("exchange did not expire only prior-login app cookies")
	}
}
