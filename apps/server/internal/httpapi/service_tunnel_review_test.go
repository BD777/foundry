package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/accounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Findings of the DEV-076 security review: per-account quotas, no caching,
// identity headers, control ports, Strict grants, sign-in link, shared notice.

func authorizeAs(f *tunnelFixture, session string) *httptest.ResponseRecorder {
	return siteRequest(f, "GET", "/api/service-tunnels/"+f.tunnel.ID+"/authorize?state="+tunnelRandom(), "", f.s.accountCookieName()+"="+session,
		map[string]string{"Accept": "text/html", "Sec-Fetch-Site": "same-origin"})
}

func TestServiceTunnelPerAccountQuotas(t *testing.T) {
	f := sameSiteFixture(t)
	for i := 0; i < userTicketLimit; i++ {
		expectStatus(t, authorizeAs(f, f.session), 200, "ticket within quota")
	}
	expectStatus(t, authorizeAs(f, f.session), 429, "ticket over quota")

	rt := &f.s.tunnels
	rt.mu.Lock()
	rt.pruneLocked()
	clear(rt.tickets)
	base := time.Now().Add(time.Hour)
	for i := 0; i < userGrantLimit; i++ {
		rt.grants[fmt.Sprint("g", i)] = previewGrant{TunnelID: f.tunnel.ID, UserID: f.userID, SessionHash: "s", Expires: base.Add(time.Duration(i) * time.Minute)}
	}
	rt.grants["other"] = previewGrant{UserID: "someone-else", Expires: base}
	rt.evictOldestGrantLocked(f.userID)
	_, oldest := rt.grants["g0"]
	_, others := rt.grants["other"]
	count := len(rt.grants)
	rt.mu.Unlock()
	if oldest || !others || count != userGrantLimit {
		t.Fatalf("grant eviction: oldest kept=%v other kept=%v count=%d", oldest, others, count)
	}
	rt.dropSession("s")
	rt.mu.Lock()
	left := len(rt.grants)
	rt.mu.Unlock()
	if left != 1 {
		t.Fatal("ended login kept its grants", left)
	}

	rt.mu.Lock()
	for i := 0; i < userStreamLimit; i++ {
		rt.streams[fmt.Sprint("s", i)] = &serviceTunnelStream{userID: f.userID, tunnel: store.ServiceTunnel{ID: fmt.Sprint("t", i), DeviceID: fmt.Sprint("d", i)}, ctx: context.Background()}
	}
	rt.mu.Unlock()
	f.control.lastData.Store(time.Now().UnixNano())
	if _, _, err := f.s.openServiceStream(context.Background(), f.tunnel, f.control, f.userID); err == nil || !strings.Contains(err.Error(), "limit") {
		t.Fatal("stream quota not enforced", err)
	}
	rt.mu.Lock()
	clear(rt.streams)
	rt.mu.Unlock()
}

func TestServiceTunnelLogoutDropsGrants(t *testing.T) {
	f := sameSiteFixture(t)
	f.grant(t)
	siteRequest(f, "POST", "/api/auth/logout", "", f.s.accountCookieName()+"="+f.session, map[string]string{"Origin": f.s.options.AllowedOrigin})
	f.s.tunnels.mu.Lock()
	defer f.s.tunnels.mu.Unlock()
	for _, g := range f.s.tunnels.grants {
		if g.SessionHash == accounts.HashToken(f.session) {
			t.Fatal("grant outlived the Foundry login")
		}
	}
}

func TestServiceTunnelHostResponsesAreNeverCached(t *testing.T) {
	f := sameSiteFixture(t)
	for _, host := range []string{"nothing-0123456789abcdef0123456789abcdef.foundry.example", "probe-0123456789abcdef0123456789abcdef.foundry.example", f.s.tunnelHostname(f.tunnel)} {
		for _, path := range []string{"/logo.png", previewRouteCheckPath} {
			w := httptest.NewRecorder()
			f.s.Routes().ServeHTTP(w, httptest.NewRequest("GET", "https://"+host+path, nil))
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("%s%s: %d without no-store", host, path, w.Code)
			}
		}
	}
}

func TestServiceTunnelStripsIdentityHeaders(t *testing.T) {
	h := http.Header{}
	for _, name := range []string{"Remote-User", "X-Remote-User", "X-Forwarded-User", "X-Auth-Request-Email", "X-Webauth-User", "X-Original-Url", "X-Rewrite-Url", "Cf-Connecting-Ip", "True-Client-Ip", "X-Real-Ip", "X-Client-Ip", "Authorization"} {
		h.Set(name, "admin")
	}
	h.Set("Accept", "text/html")
	stripTunnelHeaders(h, "/")
	if len(h) != 1 || h.Get("Accept") != "text/html" {
		t.Fatalf("identity headers reached the upstream: %v", h)
	}
}

func TestServiceTunnelRefusesControlPorts(t *testing.T) {
	f := sameSiteFixture(t)
	ctx := context.Background()
	u, _ := f.s.store.GetUser(ctx, f.userID)
	a := Actor{Kind: ActorAccount, Account: &u}
	for _, port := range []int{2375, 2376, 9222, 9229, 6443, 10250, 8500} {
		if _, err := f.s.saveServiceTunnel(ctx, a, f.tunnel.WorkspaceID, "", serviceTunnelInput{Name: "x", Port: port, Protocol: "http", Visibility: "private", Enabled: true}); err == nil {
			t.Fatal("control port accepted", port)
		}
	}
	// A debugger the device recognises, on any port, is refused and never suggested.
	f.listeners.Store(&[]wsServiceListener{{Port: 18777, InWorkspace: true, Debugger: true}})
	if _, err := f.s.saveServiceTunnel(ctx, a, f.tunnel.WorkspaceID, "", serviceTunnelInput{Name: "cdp", Port: 18777, Protocol: "http", Visibility: "private", Enabled: true}); err == nil || !strings.Contains(err.Error(), "DevTools") {
		t.Fatal("debugger endpoint accepted", err)
	}
	ws, _ := f.s.store.GetWorkspace(ctx, f.tunnel.WorkspaceID)
	if detected := f.s.observeServiceTunnels(ctx, ws, nil, true); len(detected) != 0 {
		t.Fatal("debugger suggested for publishing", detected)
	}
}

func TestServiceTunnelGrantIsStrictAndSignInHasNoHostLink(t *testing.T) {
	f := sameSiteFixture(t)
	if cookie := f.grant(t); cookie.SameSite != http.SameSiteStrictMode {
		t.Fatal("grant cookie is not SameSite=Strict", cookie.SameSite)
	}
	r := httptest.NewRequest("GET", f.s.options.AllowedOrigin+"/api/service-tunnels/"+f.tunnel.ID+"/authorize", nil)
	r.Header.Set("Accept", "text/html")
	r.Header.Set("Sec-Fetch-Site", "none")
	r.Header.Set("Sec-Fetch-Mode", "navigate")
	r.Header.Set("Sec-Fetch-Dest", "document")
	w := httptest.NewRecorder()
	f.s.Routes().ServeHTTP(w, r)
	if strings.Contains(w.Body.String(), "foundry.example") && strings.Contains(w.Body.String(), f.tunnel.ID+".") || strings.Contains(w.Body.String(), f.tunnel.HostLabel) {
		t.Fatalf("sign-in page links a service host: %s", w.Body.String())
	}
}

func TestServiceTunnelSharedServiceAsksBeforeOpening(t *testing.T) {
	f := sameSiteFixture(t)
	ctx := context.Background()
	other, err := f.s.store.CreateUser(ctx, store.NewUser{Username: "teammate", PasswordHash: "unused", Role: store.RoleAdmin})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.s.store.SetWorkspaceMember(ctx, f.tunnel.WorkspaceID, other.ID, store.WorkspaceRoleMember, f.userID); err != nil {
		t.Fatal(err)
	}
	session := tunnelRandom()
	if err = f.s.store.CreateUserSession(ctx, other.ID, accounts.HashToken(session), time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	backing, _ := f.s.tunnelStore()
	shared := f.tunnel
	shared.Visibility = "workspace"
	shared.Revision = 2
	if err = backing.UpdateServiceTunnel(ctx, shared, 1); err != nil {
		t.Fatal(err)
	}
	f.tunnel = shared
	w := authorizeAs(f, session)
	expectStatus(t, w, 200, "shared authorize")
	if !strings.Contains(w.Body.String(), "Run by") || strings.Contains(w.Body.String(), "submit()") {
		t.Fatalf("shared service opened without notice: %s", w.Body.String())
	}
	if own := authorizeAs(f, f.session); !strings.Contains(own.Body.String(), "submit()") {
		t.Fatal("owner's own service no longer opens directly")
	}
}

func TestServiceTunnelProtocolIsDetected(t *testing.T) {
	f := sameSiteFixture(t)
	ctx := context.Background()
	u, _ := f.s.store.GetUser(ctx, f.userID)
	a := Actor{Kind: ActorAccount, Account: &u}
	f.listeners.Store(&[]wsServiceListener{{Port: 18801, InWorkspace: true, TLS: true}, {Port: 18802, InWorkspace: true}})
	for port, want := range map[int]string{18801: "https", 18802: "http", 18803: "http"} {
		item, err := f.s.saveServiceTunnel(ctx, a, f.tunnel.WorkspaceID, "", serviceTunnelInput{Name: "auto", Port: port, Visibility: "private", Enabled: true})
		if err != nil || item.Protocol != want {
			t.Fatalf("port %d protocol = %q, want %q (%v)", port, item.Protocol, want, err)
		}
	}
}
