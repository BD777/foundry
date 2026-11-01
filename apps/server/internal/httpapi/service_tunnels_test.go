package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/accounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type tunnelFixture struct {
	s                           *Server
	server                      *httptest.Server
	tunnel                      store.ServiceTunnel
	control                     *daemonConnection
	session, userID, credential string
	// listeners is what the fake device reports for list_service_listeners.
	listeners *atomic.Pointer[[]wsServiceListener]
}

func newTunnelFixture(t *testing.T, upstream http.Handler) *tunnelFixture {
	t.Helper()
	ctx := context.Background()
	local := httptest.NewServer(upstream)
	t.Cleanup(local.Close)
	u, _ := url.Parse(local.URL)
	port, _ := strconv.Atoi(u.Port())
	db := newEmptyTestStore(t)
	s := NewServerWithOptions(db, ServerOptions{AllowedOrigin: accountsTestOrigin, PreviewDomain: "preview.example.net"})
	credential := pairTestDevice(t, s, "dev_tunnel", "tunnel-test-machine")
	handler := s.Routes()
	registered := doAuthCall(t, handler, authCall{method: "POST", path: "/api/daemon/register", body: registrationBody("dev_tunnel", "ws_tunnel"), headers: map[string]string{deviceCredentialHeader: credential}})
	expectStatus(t, registered, 200, "register")
	owner, _ := s.store.DeviceOwner(ctx, "dev_tunnel")
	session := tunnelRandom()
	if err := s.store.CreateUserSession(ctx, owner, accounts.HashToken(session), time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	item := store.ServiceTunnel{HostLabel: newServiceHostLabel("Synthetic"), ID: tunnelRandom()[:32], WorkspaceID: "ws_tunnel", TargetWorkspaceID: "ws_tunnel", DeviceID: "dev_tunnel", OwnerUserID: owner, Port: port, Protocol: "http", Name: "Synthetic", Visibility: "private", Enabled: true, Revision: 1}
	if err := db.CreateServiceTunnel(ctx, item); err != nil {
		t.Fatal(err)
	}
	c := newDaemonConnection(s.hub, nil)
	c.deviceID = item.DeviceID
	c.actor.DeviceCredentialHash = accounts.HashToken(credential)
	c.registration.Capabilities = []string{serviceTunnelCapability, serviceListenersCapability}
	listeners := &atomic.Pointer[[]wsServiceListener]{}
	listeners.Store(&[]wsServiceListener{{Port: port}})
	s.hub.connections[item.DeviceID] = c
	server := httptest.NewServer(handler)
	t.Cleanup(func() { c.endLifetime(); close(c.done); s.tunnels.closeAll(); server.Close() })
	go func() {
		for {
			select {
			case <-c.done:
				return
			case envelope := <-c.send:
				if envelope.Type == wsListServiceListenersType {
					reply, _ := json.Marshal(wsServiceListenersListedPayload{WorkspaceID: "ws_tunnel", Listeners: *listeners.Load()})
					c.rpc.resolve(envelope.ID, reply)
					continue
				}
				if envelope.Type != wsServiceTunnelOpenType {
					continue
				}
				var p wsServiceTunnelOpenPayload
				if json.Unmarshal(envelope.Payload, &p) != nil {
					continue
				}
				go func() {
					localConn, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(p.Port)))
					if err != nil {
						return
					}
					defer localConn.Close()
					headers := http.Header{deviceCredentialHeader: {credential}}
					if s.options.PreviewSameSite {
						u, _ := url.Parse(s.options.AllowedOrigin)
						headers.Set("Host", u.Host)
					}
					ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/api/daemon/service-tunnels/"+p.StreamID, headers)
					if err != nil {
						return
					}
					data := newTunnelNetConn(ws)
					defer data.Close()
					done := make(chan struct{})
					go func() { _, _ = io.Copy(data, localConn); close(done) }()
					_, _ = io.Copy(localConn, data)
					localConn.Close()
					data.Close()
					<-done
				}()
			}
		}
	}()
	return &tunnelFixture{s, server, item, c, session, owner, credential, listeners}
}
func (f *tunnelFixture) grant(t *testing.T) *http.Cookie {
	t.Helper()
	handler := f.s.Routes()
	state := tunnelRandom()
	authRequest := httptest.NewRequest("GET", f.s.options.AllowedOrigin+"/api/service-tunnels/"+f.tunnel.ID+"/authorize?state="+state, nil)
	authRequest.AddCookie(&http.Cookie{Name: f.s.accountCookieName(), Value: f.session})
	authRequest.Header.Set("Sec-Fetch-Site", "same-origin")
	auth := httptest.NewRecorder()
	handler.ServeHTTP(auth, authRequest)
	expectStatus(t, auth, 200, "authorize")
	match := regexp.MustCompile(`name="ticket" value="([a-f0-9]+)"`).FindStringSubmatch(auth.Body.String())
	if len(match) != 2 {
		t.Fatal("missing ticket")
	}
	exchange := func() *httptest.ResponseRecorder {
		request := httptest.NewRequest("POST", f.s.tunnelURL(f.tunnel)+"/.foundry/exchange", strings.NewReader(url.Values{"ticket": {match[1]}}.Encode()))
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		request.Header.Set("Origin", accountsTestOrigin)
		request.AddCookie(&http.Cookie{Name: previewStateCookie, Value: state})
		record := httptest.NewRecorder()
		handler.ServeHTTP(record, request)
		return record
	}
	record := exchange()
	expectStatus(t, record, 303, "exchange")
	expectStatus(t, exchange(), 403, "single use")
	for _, cookie := range record.Result().Cookies() {
		if cookie.Name == previewCookie {
			if cookie.Domain != "" || !cookie.Secure || !cookie.HttpOnly {
				t.Fatal("unsafe cookie")
			}
			return cookie
		}
	}
	t.Fatal("missing preview cookie")
	return nil
}
func (f *tunnelFixture) request(t *testing.T, method, path string, body io.Reader, cookie *http.Cookie) *http.Response {
	t.Helper()
	request, err := http.NewRequest(method, f.server.URL+path, body)
	if err != nil {
		t.Fatal(err)
	}
	request.Host = f.s.tunnelHostname(f.tunnel)
	if cookie != nil {
		request.AddCookie(cookie)
	}
	request.Header.Set("Origin", "https://"+request.Host)
	response, err := (&http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}
func TestServiceTunnelStreamingHeadersAndDownload(t *testing.T) {
	data := bytes.Repeat([]byte("download-content\n"), 512*1024)
	f := newTunnelFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/download":
			w.Header().Set("Content-Disposition", `attachment; filename="example.bin"`)
			w.Write(data)
		case "/redirect":
			w.Header().Set("Location", "http://"+r.Host+"/absolute.css")
			w.WriteHeader(302)
		case "/metadata":
			w.Header().Set("Location", "http://169.254.169.254/latest/meta-data/")
			w.WriteHeader(302)
		case "/cookies":
			w.Header().Add("Set-Cookie", "app=one; Domain=.example.net; Path=/")
			w.Header().Add("Set-Cookie", previewCookie+"=poison; Path=/")
			fmt.Fprint(w, "ok")
		default:
			if r.Header.Get(deviceCredentialHeader) != "" || strings.Contains(r.Header.Get("Cookie"), "foundry") {
				w.WriteHeader(500)
				return
			}
			_ = http.NewResponseController(w).EnableFullDuplex()
			io.Copy(w, r.Body)
		}
	}))
	cookie := f.grant(t)
	response := f.request(t, "GET", "/download", nil, cookie)
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || sha256.Sum256(body) != sha256.Sum256(data) || response.Header.Get("Content-Disposition") == "" {
		t.Fatal("download corrupted")
	}
	response = f.request(t, "POST", "/echo", bytes.NewReader(data[:512*1024]), cookie)
	body, _ = io.ReadAll(response.Body)
	response.Body.Close()
	if !bytes.Equal(body, data[:512*1024]) {
		t.Fatalf("upload corrupted: status=%d bytes=%d", response.StatusCode, len(body))
	}
	response = f.request(t, "GET", "/redirect", nil, cookie)
	response.Body.Close()
	if response.Header.Get("Location") != "https://"+f.tunnel.ID+".preview.example.net/absolute.css" {
		t.Fatal("redirect escaped origin")
	}
	response = f.request(t, "GET", "/metadata", nil, cookie)
	response.Body.Close()
	if response.StatusCode != 502 {
		t.Fatal("metadata redirect allowed")
	}
	response = f.request(t, "GET", "/cookies", nil, cookie)
	response.Body.Close()
	cookies := response.Cookies()
	if len(cookies) != 1 || !strings.HasPrefix(cookies[0].Name, appCookiePrefix) || cookies[0].Domain != "" || !cookies[0].Secure {
		t.Fatal("cookie isolation failed")
	}
}
func TestServiceTunnelAuthorizationAndOriginIsolation(t *testing.T) {
	f := newTunnelFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "upstream") }))
	response := f.request(t, "GET", "/api/auth/state", nil, nil)
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal("preview exposed control API")
	}
	cookie := f.grant(t)
	response = f.request(t, "GET", "/api/auth/state", nil, cookie)
	raw, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if string(raw) != "upstream" {
		t.Fatal("preview reached Foundry API")
	}
	req := httptest.NewRequest("POST", "https://"+f.tunnel.ID+".preview.example.net/", nil)
	req.AddCookie(cookie)
	req.Header.Set("Origin", "https://attacker.example")
	record := httptest.NewRecorder()
	f.s.Routes().ServeHTTP(record, req)
	expectStatus(t, record, 403, "cross origin")
	other, err := f.s.store.CreateUser(context.Background(), store.NewUser{Username: "another-member", PasswordHash: "unused", Role: store.RoleAdmin})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.s.store.SetWorkspaceMember(context.Background(), f.tunnel.WorkspaceID, other.ID, store.WorkspaceRoleMember, f.userID); err != nil {
		t.Fatal(err)
	}
	if f.s.authorizeTunnel(context.Background(), f.tunnel, other.ID) {
		t.Fatal("member inherited private service")
	}
	shared := f.tunnel
	shared.Visibility = "workspace"
	if !f.s.authorizeTunnel(context.Background(), shared, other.ID) {
		t.Fatal("explicit sharing denied")
	}
	if err = f.s.store.SetWorkspaceMember(context.Background(), f.tunnel.WorkspaceID, other.ID, store.WorkspaceRoleViewer, f.userID); err != nil {
		t.Fatal(err)
	}
	if f.s.authorizeTunnel(context.Background(), shared, other.ID) {
		t.Fatal("viewer acquired application authority")
	}
	if err = f.s.store.DeleteUserSession(context.Background(), accounts.HashToken(f.session)); err != nil {
		t.Fatal(err)
	}
	response = f.request(t, "GET", "/", nil, cookie)
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("logout did not revoke")
	}
}
func TestServiceTunnelSSEAndWebSocketRevocation(t *testing.T) {
	f := newTunnelFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/events" {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: ready\n\n")
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			return
		}
		ws, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		for {
			kind, p, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if ws.WriteMessage(kind, p) != nil {
				return
			}
		}
	}))
	cookie := f.grant(t)
	started := time.Now()
	response := f.request(t, "GET", "/events", nil, cookie)
	first := make([]byte, len("data: ready\n\n"))
	if _, err := io.ReadFull(response.Body, first); err != nil {
		t.Fatal(err)
	}
	if time.Since(started) > 2*time.Second {
		t.Fatal("SSE buffered")
	}
	h := http.Header{"Host": {f.tunnel.ID + ".preview.example.net"}, "Cookie": {cookie.Name + "=" + cookie.Value}, "Origin": {"https://" + f.tunnel.ID + ".preview.example.net"}}
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(f.server.URL, "http")+"/socket", h)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	ws.WriteMessage(websocket.TextMessage, []byte("echo"))
	_, raw, err := ws.ReadMessage()
	if err != nil || string(raw) != "echo" {
		t.Fatalf("websocket echo %s %v", raw, err)
	}
	if err = f.s.store.DeleteUserSession(context.Background(), accounts.HashToken(f.session)); err != nil {
		t.Fatal(err)
	}
	ws.SetReadDeadline(time.Now().Add(7 * time.Second))
	_, _, err = ws.ReadMessage()
	if err == nil {
		t.Fatal("revoked websocket survived")
	}
	io.ReadAll(response.Body)
	response.Body.Close()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		f.s.tunnels.mu.Lock()
		n := len(f.s.tunnels.streams)
		f.s.tunnels.mu.Unlock()
		if n == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("stream resources leaked")
}
func TestServiceTunnelConfigurationAndTargets(t *testing.T) {
	s := &Server{options: ServerOptions{AllowedOrigin: "https://dev.foundry.co.uk"}}
	for _, domain := range []string{"preview.foundry.co.uk", "foundry.co.uk", "https://preview.example.net", "*.preview.example.net", "co.uk"} {
		s.options.PreviewDomain = domain
		if s.previewDomain() != "" {
			t.Fatalf("unsafe site %s", domain)
		}
	}
	s.options.PreviewDomain = "preview.example.net"
	if s.previewDomain() == "" {
		t.Fatal("separate site refused")
	}
	for _, port := range []int{0, 22, 443, 1023, 31982, 31983, 65536} {
		if validTunnelPort(port) {
			t.Fatalf("unsafe port %d", port)
		}
	}
	h := http.Header{"Cookie": {"foundry_session=secret; __Host-foundry_preview=secret; app=ok"}, "Authorization": {"Bearer secret"}, deviceCredentialHeader: {"secret"}, "X-Forwarded-Host": {"metadata"}}
	stripTunnelHeaders(h, "/")
	if h.Get("Cookie") != "" || h.Get("Authorization") != "" || h.Get(deviceCredentialHeader) != "" {
		t.Fatal("credential leaked")
	}
}

func TestServiceTunnelApplicationCookieScope(t *testing.T) {
	cookie := scopeAppCookie(&http.Cookie{Name: "app", Value: "session", Path: "/account", Domain: ".example.net"}, "/")
	if cookie.Domain != "" || cookie.Path != "/" || !cookie.Secure || !strings.HasPrefix(cookie.Name, "__Host-") {
		t.Fatal("cookie is not browser-isolated")
	}
	if got := unscopedAppCookie(cookie, "/account/profile"); got == nil || got.Name != "app" || got.Value != "session" {
		t.Fatal("application cookie not restored")
	}
	if unscopedAppCookie(cookie, "/accounting") != nil {
		t.Fatal("cookie path escaped")
	}
	if unscopedAppCookie(&http.Cookie{Name: "app", Value: "parent-domain-poison"}, "/") != nil {
		t.Fatal("unscoped browser cookie accepted")
	}
}

func TestServiceTunnelCookiesPreservePathsDeletionAndReservedNames(t *testing.T) {
	root := scopeAppCookie(&http.Cookie{Name: "session", Value: "root", Path: "/", HttpOnly: true}, "/")
	account := scopeAppCookie(&http.Cookie{Name: "session", Value: "account", Path: "/account", HttpOnly: true}, "/")
	if root.Name == account.Name {
		t.Fatal("same-name cookie paths collapsed")
	}
	request := &http.Request{Header: make(http.Header)}
	request.AddCookie(root)
	request.AddCookie(account)
	stripTunnelHeaders(request.Header, "/account/settings")
	if request.Header.Get("Cookie") != "session=account; session=root" {
		t.Fatalf("path precedence: %s", request.Header.Get("Cookie"))
	}
	deletion := scopeAppCookie(&http.Cookie{Name: "session", Value: "", Path: "/account", MaxAge: -1, Expires: time.Unix(1, 0)}, "/")
	if deletion.Name != account.Name || deletion.MaxAge != -1 || !deletion.Expires.Equal(time.Unix(1, 0)) {
		t.Fatal("deletion scope/expiry changed")
	}
	for _, name := range []string{sessionCookieName, previewCookie, previewStateCookie, "__Host-foundry_anything"} {
		poisoned := scopeAppCookie(&http.Cookie{Name: name, Value: "poison", Path: "/"}, "/")
		if unscopedAppCookie(poisoned, "/") != nil {
			t.Fatalf("decoded protected name %s", name)
		}
	}
	implicit := scopeAppCookie(&http.Cookie{Name: "app", Value: "ok"}, "/one/two")
	if unscopedAppCookie(implicit, "/other") != nil || unscopedAppCookie(implicit, "/one/three") == nil {
		t.Fatal("default path lost")
	}
}
func TestServiceTunnelCredentialRevocationAndMappingChanges(t *testing.T) {
	f := newTunnelFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "ready") }))
	cookie := f.grant(t)
	if err := f.s.store.RevokeDeviceCredential(context.Background(), f.tunnel.DeviceID); err != nil {
		t.Fatal(err)
	}
	response := f.request(t, "GET", "/", nil, cookie)
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("revoked device credential accepted on live control socket")
	}
}
func TestServiceTunnelRegistrationTargetsAndIdempotency(t *testing.T) {
	f := newTunnelFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "ready") }))
	ctx := context.Background()
	user, _ := f.s.store.GetUser(ctx, f.userID)
	actor := Actor{Kind: ActorAccount, Account: &user}
	input := serviceTunnelInput{Name: "known service", Port: 18082, Protocol: "http", Visibility: "private", Enabled: true, RegistrationKey: "known-service"}
	first, err := f.s.saveServiceTunnel(ctx, actor, f.tunnel.WorkspaceID, "", input)
	if err != nil {
		t.Fatal(err)
	}
	repeated, err := f.s.saveServiceTunnel(ctx, actor, f.tunnel.WorkspaceID, "", input)
	if err != nil || repeated.ID != first.ID {
		t.Fatal("registration retry duplicated mapping")
	}
	input.Port = 18083
	if _, err = f.s.saveServiceTunnel(ctx, actor, f.tunnel.WorkspaceID, "", input); errorStatus(err) != 409 {
		t.Fatal("retry key changed target")
	}
	input.Port = 18082
	input.ExpectedRevision = 99
	input.Enabled = false
	if _, err = f.s.saveServiceTunnel(ctx, actor, f.tunnel.WorkspaceID, first.ID, input); errorStatus(err) != 409 {
		t.Fatal("stale mapping edit accepted")
	}
	input.ExpectedRevision = 1
	updated, err := f.s.saveServiceTunnel(ctx, actor, f.tunnel.WorkspaceID, first.ID, input)
	if err != nil || updated.Enabled || updated.Revision != 2 {
		t.Fatal("disable failed")
	}
	// A workspace on a second device is the display location, never the target.
	pair := tunnelRandom()
	credential := tunnelRandom()
	if err = f.s.store.CreateDevicePairingToken(ctx, accounts.HashToken(pair), f.userID, time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.store.PairDevice(ctx, store.PairDeviceInput{TokenHash: accounts.HashToken(pair), CredentialHash: accounts.HashToken(credential), RequestedDeviceID: "dev_source", WorkerFingerprint: "source-machine", Now: time.Now()}); err != nil {
		t.Fatal(err)
	}
	result := doAuthCall(t, f.s.Routes(), authCall{method: "POST", path: "/api/daemon/register", body: registrationBody("dev_source", "ws_source"), headers: map[string]string{deviceCredentialHeader: credential}})
	expectStatus(t, result, 200, "register source")
	input.TargetWorkspaceID = f.tunnel.WorkspaceID
	input.RegistrationKey = "remote-service"
	input.Enabled = true
	remote, err := f.s.saveServiceTunnel(ctx, actor, "ws_source", "", input)
	if err != nil {
		t.Fatal(err)
	}
	if remote.DeviceID != f.tunnel.DeviceID || remote.WorkspaceID != "ws_source" || remote.TargetWorkspaceID != f.tunnel.WorkspaceID {
		t.Fatal("display device confused with executing device")
	}
	input.TargetWorkspaceID = "ws_nonexistent"
	input.RegistrationKey = "unknown"
	if _, err = f.s.saveServiceTunnel(ctx, actor, "ws_source", "", input); errorStatus(err) != 403 {
		t.Fatal("unknown target workspace accepted")
	}
}

func TestServiceTunnelWriteStallBoundsBackpressureWithoutIdleLifetime(t *testing.T) {
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	conn := tunnelDownstreamConn{Conn: server, stall: 100 * time.Millisecond}
	started := time.Now()
	if _, err := conn.Write([]byte("blocked")); err == nil {
		t.Fatal("stalled downstream write did not expire")
	}
	if time.Since(started) > time.Second {
		t.Fatal("write exceeded its bound")
	}
	time.Sleep(150 * time.Millisecond)
	answer := make(chan string, 1)
	go func() {
		buf := make([]byte, 2)
		_, err := io.ReadFull(client, buf)
		if err != nil {
			answer <- err.Error()
		} else {
			answer <- string(buf)
		}
	}()
	if _, err := conn.Write([]byte("ok")); err != nil {
		t.Fatalf("idle connection inherited an expired write deadline: %v", err)
	}
	if got := <-answer; got != "ok" {
		t.Fatal(got)
	}
}

func TestServiceTunnelAccountSwitchRevokesPreviousBrowserGrant(t *testing.T) {
	f := newTunnelFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "private") }))
	cookie := f.grant(t)
	hash, err := accounts.HashPassword("second-local-password")
	if err != nil {
		t.Fatal(err)
	}
	other, err := f.s.store.CreateUser(context.Background(), store.NewUser{Username: "second-browser-account", PasswordHash: hash, Role: store.RoleMember})
	if err != nil {
		t.Fatal(err)
	}
	result := doAuthCall(t, f.s.Routes(), authCall{method: "POST", path: "/api/auth/login", body: `{"username":"second-browser-account","password":"second-local-password"}`, cookie: f.session, origin: accountsTestOrigin})
	expectStatus(t, result, 200, "replace browser account")
	if _, _, err = f.s.store.ResolveUserSession(context.Background(), accounts.HashToken(f.session), time.Now(), time.Time{}, time.Time{}); err == nil {
		t.Fatal("previous browser login survived account replacement")
	}
	next := sessionCookieFrom(t, result)
	user, _, err := f.s.store.ResolveUserSession(context.Background(), accounts.HashToken(next.Value), time.Now(), time.Time{}, time.Time{})
	if err != nil || user.ID != other.ID {
		t.Fatal("replacement login not usable")
	}
	response := f.request(t, "GET", "/", nil, cookie)
	defer response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("previous account preview grant survived")
	}
	cleared := false
	for _, c := range response.Cookies() {
		if c.Name == previewCookie && c.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Fatal("expired preview cookie traps later logins")
	}
}

func TestServiceTunnelCookiePathsUseEscapedRequestPath(t *testing.T) {
	f := newTunnelFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, r.Header.Get("Cookie")) }))
	auth := f.grant(t)
	app := scopeAppCookie(&http.Cookie{Name: "restricted", Value: "synthetic", Path: "/a/b"}, "/", previewAppCookieAudience(previewGrant{TunnelID: f.tunnel.ID, SessionHash: accounts.HashToken(f.session)}))
	positive := httptest.NewRequest("GET", f.s.tunnelURL(f.tunnel)+"/a/b/cookies", nil)
	positive.AddCookie(auth)
	positive.AddCookie(app)
	matched := httptest.NewRecorder()
	f.s.Routes().ServeHTTP(matched, positive)
	expectStatus(t, matched, 200, "matching cookie path")
	if matched.Body.String() != "restricted=synthetic" {
		t.Fatal("path test cookie was not authenticated")
	}
	request := httptest.NewRequest("GET", "https://"+f.tunnel.ID+".preview.example.net/a%2Fb/cookies", nil)
	request.AddCookie(auth)
	request.AddCookie(app)
	record := httptest.NewRecorder()
	f.s.Routes().ServeHTTP(record, request)
	expectStatus(t, record, 200, "encoded path")
	if record.Body.Len() != 0 {
		t.Fatal("cookie crossed an encoded slash path boundary")
	}
}

func TestServiceTunnelRejectsBrowserAmbiguousRedirects(t *testing.T) {
	target, _ := url.Parse("http://127.0.0.1:18082")
	for _, location := range []string{"///169.254.169.254/latest/meta-data", "////external.example/path", "/\\external.example/path"} {
		response := &http.Response{Header: http.Header{"Location": {location}}}
		if rewriteTunnelResponse(response, target, "https://app.preview.example.net") == nil {
			t.Fatalf("ambiguous browser redirect accepted: %q", location)
		}
	}
}
