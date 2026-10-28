package httpapi

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
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
	for _, host := range []string{"unknown.foundry.example", "evil." + f.s.tunnelHostname(f.tunnel), "www.foundry.example", "api.foundry.example", "dev-0123456789abcdef0123456789abcdef.foundry.example", "foundry.example.evil.test", "foundry.example:444", "127.0.0.1"} {
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
	input := serviceTunnelInput{Name: "Atlas", Port: 18082, Protocol: "http", Visibility: "private", Enabled: true, RegistrationKey: "retry"}
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
	if !strings.HasPrefix(oldURL, "https://") || strings.Contains(strings.TrimSuffix(strings.TrimPrefix(oldURL, "https://"), ".foundry.example"), ".") || !serviceHostLabel.MatchString(first.HostLabel) {
		t.Fatal("service host is not a first-level random label", oldURL)
	}
	copy := updated
	copy.DeviceID = "other"
	copy.TargetWorkspaceID = "other"
	if f.s.tunnelURL(copy) != oldURL {
		t.Fatal("execution location determines hostname")
	}
	if newServiceHostLabel("Atlas") == newServiceHostLabel("Atlas") {
		t.Fatal("origin reused")
	}
	for _, reserved := range []string{"dev", "www", "api", "app", "dev-foundry"} {
		if serviceHostLabel.MatchString(reserved) {
			t.Fatal("service label shape can shadow a real host", reserved)
		}
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

// A registered service is same-site with the control origin. Its pages may
// send the person's SameSite=Lax control cookie on same-site requests, so
// every account-cookie request must name the exact control origin.
func TestServiceTunnelSameSiteServiceOriginCannotUseControlAPI(t *testing.T) {
	f := sameSiteFixture(t)
	service := "https://" + f.s.tunnelHostname(f.tunnel)
	good := f.s.accountCookieName() + "=" + f.session
	for _, c := range []struct{ method, path, body string }{
		{"GET", "/api/workspaces/ws_tunnel/service-tunnels", ""},
		{"GET", "/api/auth/state", ""},
		{"POST", "/api/workspaces/ws_tunnel/service-tunnels", `{"name":"x","port":18090,"protocol":"http","visibility":"private","enabled":true}`},
		{"DELETE", "/api/workspaces/ws_tunnel/service-tunnels/" + f.tunnel.ID, ""},
		{"POST", "/api/auth/logout", ""},
	} {
		for _, headers := range []map[string]string{
			{"Origin": service},
			{"Origin": service, "Sec-Fetch-Site": "same-site"},
			{"Referer": service + "/", "Sec-Fetch-Site": "same-site"},
		} {
			expectStatus(t, siteRequest(f, c.method, c.path, c.body, good, headers), 403, "service origin "+c.method+" "+c.path)
		}
	}
	expectStatus(t, siteRequest(f, "GET", "/api/events", "", good, map[string]string{"Upgrade": "websocket", "Origin": service}), 403, "service origin WebSocket")
	// The preview grant cookie is host-only and prefixed, so the control origin
	// never receives it and a sibling cannot plant one with Domain=.
	cookie := f.grant(t)
	if !strings.HasPrefix(cookie.Name, "__Host-") || cookie.Domain != "" || !cookie.Secure || !cookie.HttpOnly {
		t.Fatal("preview grant cookie is not host-only", cookie)
	}
	expectStatus(t, siteRequest(f, "GET", "/api/workspaces/ws_tunnel/service-tunnels", "", cookie.Name+"="+cookie.Value, map[string]string{"Sec-Fetch-Site": "same-origin"}), 401, "preview grant is not a control credential")
}

func TestServiceTunnelListenersReportLivenessDetectionAndRemoval(t *testing.T) {
	f := sameSiteFixture(t)
	good := f.s.accountCookieName() + "=" + f.session
	read := func() store.ServiceTunnelList {
		f.s.tunnels.listenMu.Lock()
		f.s.tunnels.listeners = nil
		f.s.tunnels.listenMu.Unlock()
		w := siteRequest(f, "GET", "/api/workspaces/ws_tunnel/service-tunnels", "", good, map[string]string{"Sec-Fetch-Site": "same-origin"})
		expectStatus(t, w, 200, "list")
		var list store.ServiceTunnelList
		if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
			t.Fatal(err)
		}
		return list
	}
	f.listeners.Store(&[]wsServiceListener{
		{Port: f.tunnel.Port},
		{Port: 18555, Process: "python3 serve.py", InWorkspace: true},
		{Port: 18556, Process: "elsewhere"},
		{Port: 31982, InWorkspace: true},
	})
	list := read()
	if len(list.Items) != 1 || list.Items[0].Status != "ready" || list.Items[0].LastSeenAt == "" {
		t.Fatalf("listening mapping not ready/seen: %+v", list.Items)
	}
	if len(list.Detected) != 1 || list.Detected[0].Port != 18555 || list.Detected[0].Process != "python3 serve.py" {
		t.Fatalf("detected = %+v, want only the workspace listener", list.Detected)
	}
	f.listeners.Store(&[]wsServiceListener{})
	list = read()
	if list.Items[0].Status != "not_listening" || list.Items[0].LastSeenAt == "" {
		t.Fatalf("stopped server not reported: %+v", list.Items[0])
	}
	// A device that cannot report keeps the capability status, never a guess.
	f.control.registration.Capabilities = []string{serviceTunnelCapability}
	if list = read(); list.Items[0].Status != "ready" || list.Detected != nil {
		t.Fatalf("old worker status = %+v", list)
	}
	cookie := f.grant(t)
	path := "/api/workspaces/ws_tunnel/service-tunnels/" + f.tunnel.ID
	expectStatus(t, siteRequest(f, "DELETE", path, "", good, map[string]string{"Origin": f.s.options.AllowedOrigin}), 204, "remove")
	expectStatus(t, siteRequest(f, "DELETE", path, "", good, map[string]string{"Origin": f.s.options.AllowedOrigin}), 404, "remove twice")
	if list = read(); len(list.Items) != 0 {
		t.Fatal("removed mapping still listed")
	}
	r := httptest.NewRequest("GET", "https://"+f.s.tunnelHostname(f.tunnel)+"/", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	f.s.Routes().ServeHTTP(w, r)
	expectStatus(t, w, 404, "removed host")
}

func TestServiceTunnelSameSiteDomainDefaultsToControlSite(t *testing.T) {
	s := &Server{options: ServerOptions{AllowedOrigin: "https://dev.foundry.example", PreviewSameSite: true}}
	if got := s.previewDomain(); got != "foundry.example" {
		t.Fatalf("previewDomain() = %q, want the control site", got)
	}
	s.options.PreviewSameSite = false
	if got := s.previewDomain(); got != "" {
		t.Fatalf("separate-site mode invented a domain %q", got)
	}
}

func TestServiceTunnelURLsWaitForAVerifiedPublicRoute(t *testing.T) {
	f := sameSiteFixture(t)
	ctx := context.Background()
	via := func(handler http.Handler) *http.Client {
		edge := httptest.NewTLSServer(handler)
		t.Cleanup(edge.Close)
		return &http.Client{Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
			DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, network, edge.Listener.Addr().String())
			},
		}}
	}
	// A catch-all that answers every host, as before ingress is configured.
	if f.s.checkPreviewRoute(ctx, via(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))) {
		t.Fatal("an unrelated catch-all counted as a route to this server")
	}
	if !f.s.checkPreviewRoute(ctx, via(f.s.Routes())) {
		t.Fatal("the probe did not come back through a route to this server")
	}
	// Only the label in flight is answered; nothing leaks between probes.
	w := httptest.NewRecorder()
	f.s.Routes().ServeHTTP(w, httptest.NewRequest("GET", "https://probe-0123456789abcdef0123456789abcdef.foundry.example"+previewRouteCheckPath, nil))
	expectStatus(t, w, 404, "stale probe label")

	good := f.s.accountCookieName() + "=" + f.session
	list := func() store.ServiceTunnelList {
		w := siteRequest(f, "GET", "/api/workspaces/ws_tunnel/service-tunnels", "", good, map[string]string{"Sec-Fetch-Site": "same-origin"})
		var out store.ServiceTunnelList
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return out
	}
	f.s.previewProbe.checking.Store(true)
	if got := list(); got.Routed || got.Items[0].URL != "" || got.Items[0].Status != "preview_unrouted" {
		t.Fatalf("unverified route published a link: %+v", got)
	}
	f.s.previewProbe.routed.Store(true)
	if got := list(); !got.Routed || got.Items[0].URL == "" {
		t.Fatalf("verified route withheld the link: %+v", got)
	}
}
