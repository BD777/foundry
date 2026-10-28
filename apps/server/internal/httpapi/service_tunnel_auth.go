package httpapi

import (
	"context"
	"encoding/hex"
	"html/template"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/accounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const previewCookie = "__Host-foundry_preview"
const previewStateCookie = "__Host-foundry_preview_state"

type previewGrant struct {
	TunnelID    string
	Revision    int64
	UserID      string
	SessionHash string
	State       string
	Expires     time.Time
}
type serviceTunnelRuntime struct {
	mu      sync.Mutex
	tickets map[string]previewGrant
	grants  map[string]previewGrant
	streams map[string]*serviceTunnelStream
	stopped bool
	// listeners caches each workspace's device report briefly: every open
	// Services page polls, and one scan per device answers all of them.
	listenMu  sync.Mutex
	listeners map[string]listenerSnapshot
}

func (t *serviceTunnelRuntime) pruneLocked() {
	if t.tickets == nil {
		t.tickets = map[string]previewGrant{}
		t.grants = map[string]previewGrant{}
		t.streams = map[string]*serviceTunnelStream{}
	}
	now := time.Now()
	for key, g := range t.tickets {
		if now.After(g.Expires) {
			delete(t.tickets, key)
		}
	}
	for key, g := range t.grants {
		if now.After(g.Expires) {
			delete(t.grants, key)
		}
	}
}
func (t *serviceTunnelRuntime) invalidate(id string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.pruneLocked()
	for k, g := range t.grants {
		if g.TunnelID == id {
			delete(t.grants, k)
		}
	}
	for k, g := range t.tickets {
		if g.TunnelID == id {
			delete(t.tickets, k)
		}
	}
	for _, stream := range t.streams {
		if stream.tunnel.ID == id {
			stream.cancel()
		}
	}
}
func (t *serviceTunnelRuntime) closeAll() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.pruneLocked()
	t.stopped = true
	for _, stream := range t.streams {
		stream.cancel()
	}
	clear(t.grants)
	clear(t.tickets)
}
func previewHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
	w.Header().Set("Origin-Agent-Cluster", "?1")
	w.Header().Set("Permissions-Policy", "document-domain=()")
}

// Dispatch on Host before the control-plane mux, auth or static fallback.
// A preview origin can never reach Foundry APIs, assets, cookies or CORS.
func (s *Server) withServicePreview(control http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.options.PreviewSameSite {
			s.routeSameSiteHost(w, r, control)
			return
		}
		domain := s.previewDomain()
		host := strings.ToLower(r.Host)
		if domain != "" && strings.HasSuffix(host, "."+domain) {
			id := strings.TrimSuffix(host, "."+domain)
			if s.answerPreviewProbe(w, r, id) {
				return
			}
			if !serviceTunnelID.MatchString(id) {
				http.NotFound(w, r)
				return
			}
			s.serveServicePreview(w, r, id)
			return
		}
		configured := strings.ToLower(strings.TrimSpace(s.options.PreviewDomain))
		if configured != "" && (host == configured || strings.HasSuffix(host, "."+configured)) {
			http.NotFound(w, r)
			return
		}
		control.ServeHTTP(w, r)
	})
}

func (s *Server) serveServicePreview(w http.ResponseWriter, r *http.Request, id string) {
	previewHeaders(w)
	if r.URL.Path == "/.foundry/exchange" {
		s.exchangePreview(w, r, id)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/.foundry/") || r.Header.Get("Service-Worker") != "" {
		http.Error(w, "reserved preview endpoint", 403)
		return
	}
	// Applications retain their own CSP; this additional policy forbids service
	// workers, which could otherwise intercept the login exchange on this origin.
	w.Header().Add("Content-Security-Policy", "worker-src 'none'; frame-ancestors 'self'")
	var grant previewGrant
	if cookie, err := r.Cookie(previewCookie); err == nil {
		s.tunnels.mu.Lock()
		s.tunnels.pruneLocked()
		grant = s.tunnels.grants[accounts.HashToken(cookie.Value)]
		s.tunnels.mu.Unlock()
	}
	if grant.TunnelID != id || time.Now().After(grant.Expires) {
		if r.Method != "GET" || r.Header.Get("Upgrade") != "" || !strings.Contains(r.Header.Get("Accept"), "text/html") {
			http.Error(w, "Foundry sign-in required", 401)
			return
		}
		// Only a top-level navigation starts sign-in. Cross-origin fetch/iframe
		// cannot bootstrap or replace another app's authentication.
		if dest := r.Header.Get("Sec-Fetch-Dest"); dest != "" && dest != "document" {
			http.Error(w, "open this service in a browser tab", 401)
			return
		}
		state := tunnelRandom()
		http.SetCookie(w, &http.Cookie{Name: previewStateCookie, Value: state, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteNoneMode, MaxAge: 60})
		http.Redirect(w, r, s.options.AllowedOrigin+"/api/service-tunnels/"+id+"/authorize?state="+state, http.StatusSeeOther)
		return
	}
	item, connection, ok := s.validPreviewGrant(r.Context(), grant)
	if !ok {
		http.SetCookie(w, &http.Cookie{Name: previewCookie, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: -1})
		if r.Method == "GET" && r.Header.Get("Sec-Fetch-Dest") == "document" && r.Header.Get("Sec-Fetch-Mode") == "navigate" {
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		http.Error(w, "service access expired, revoked or unavailable; reopen from Foundry", 403)
		return
	}
	origin := "https://" + r.Host
	// Requests from another origin may not drive an application's mutations or
	// websocket. Null origins and missing WS Origin fail closed.
	requestOrigin := r.Header.Get("Origin")
	topNavigation := r.Method == "GET" && r.Header.Get("Sec-Fetch-Dest") == "document" && r.Header.Get("Sec-Fetch-Mode") == "navigate"
	if !topNavigation && ((requestOrigin != "" && requestOrigin != origin) || (r.Header.Get("Upgrade") != "" && requestOrigin != origin) || (r.Method != "GET" && r.Method != "HEAD" && requestOrigin != origin)) {
		http.Error(w, "service origin required", 403)
		return
	}
	if site := r.Header.Get("Sec-Fetch-Site"); !topNavigation && (site == "cross-site" || site == "same-site") {
		http.Error(w, "cross-origin service requests are not allowed", 403)
		return
	}
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	s.proxyServiceTunnel(w, r, item, connection, grant)
}
func (s *Server) validPreviewGrant(ctx context.Context, g previewGrant) (store.ServiceTunnel, *daemonConnection, bool) {
	var empty store.ServiceTunnel
	checkCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	ctx = checkCtx
	if time.Now().After(g.Expires) {
		return empty, nil, false
	}
	user, _, err := s.store.ResolveUserSession(ctx, g.SessionHash, time.Now(), time.Time{}, time.Time{})
	if err != nil || user.ID != g.UserID {
		return empty, nil, false
	}
	backing, err := s.tunnelStore()
	if err != nil {
		return empty, nil, false
	}
	item, err := backing.GetServiceTunnel(ctx, g.TunnelID)
	if err != nil || item.Revision != g.Revision || !s.authorizeTunnel(ctx, item, g.UserID) {
		return empty, nil, false
	}
	connection, status := s.liveTunnel(item)
	if status != "ready" {
		return item, nil, false
	}
	select {
	case <-connection.done:
		return item, nil, false
	default:
	}
	identity, err := s.store.ResolveDeviceCredential(ctx, connection.actor.DeviceCredentialHash)
	if err != nil || identity.DeviceID != item.DeviceID || identity.OwnerUserID != item.OwnerUserID {
		return item, nil, false
	}
	return item, connection, true
}

var previewExchangePage = template.Must(template.New("exchange").Parse(`<!doctype html><html><head><meta name="referrer" content="origin"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening service</title></head><body><form method="post" action="{{.Action}}"><input type="hidden" name="ticket" value="{{.Ticket}}"><button type="submit">Open service / 打开服务</button></form><script nonce="{{.Nonce}}">document.forms[0].submit()</script></body></html>`))

func (s *Server) handleAuthorizeServiceTunnel(w http.ResponseWriter, r *http.Request) {
	previewHeaders(w)
	actor := actorFromContext(r.Context())
	if actor.Kind != ActorAccount || actor.Account == nil {
		writeForbidden(w, "Foundry browser sign-in required")
		return
	}
	cookie, err := r.Cookie(s.accountCookieName())
	if err != nil {
		writeError(w, 401, "Foundry browser sign-in required")
		return
	}
	state := r.URL.Query().Get("state")
	if len(state) != 64 {
		writeError(w, 400, "open the service URL first")
		return
	}
	if _, err := hexState(state); err != nil {
		writeError(w, 400, "invalid browser state")
		return
	}
	backing, err := s.tunnelStore()
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	item, err := backing.GetServiceTunnel(r.Context(), r.PathValue("tunnelId"))
	if err != nil || !s.authorizeTunnel(r.Context(), item, actor.AccountID()) {
		writeError(w, 404, "service unavailable")
		return
	}
	_, status := s.liveTunnel(item)
	if status != "ready" {
		writeError(w, 409, status)
		return
	}
	grant := previewGrant{TunnelID: item.ID, Revision: item.Revision, UserID: actor.AccountID(), SessionHash: accounts.HashToken(cookie.Value), State: state, Expires: time.Now().Add(30 * time.Second)}
	token := tunnelRandom()
	s.tunnels.mu.Lock()
	s.tunnels.pruneLocked()
	if s.tunnels.stopped || len(s.tunnels.tickets) >= 4096 {
		s.tunnels.mu.Unlock()
		writeError(w, 503, "preview login capacity reached")
		return
	}
	s.tunnels.tickets[accounts.HashToken(token)] = grant
	s.tunnels.mu.Unlock()
	nonce := tunnelRandom()
	// A no-referrer policy makes browser form POST Origin null. Send only the
	// origin (never the state URL or ticket) so the exchange can verify it.
	w.Header().Set("Referrer-Policy", "origin")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'nonce-"+nonce+"'; form-action "+s.tunnelURL(item)+"; frame-ancestors 'none'; base-uri 'none'")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = previewExchangePage.Execute(w, map[string]string{"Action": s.tunnelURL(item) + "/.foundry/exchange", "Ticket": token, "Nonce": nonce})
}
func hexState(state string) ([]byte, error) { return hex.DecodeString(state) }

func (s *Server) exchangePreview(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != "POST" || r.Header.Get("Origin") != s.options.AllowedOrigin {
		http.Error(w, "login exchange origin refused", 403)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid login exchange", 400)
		return
	}
	state, err := r.Cookie(previewStateCookie)
	if err != nil {
		http.Error(w, "login browser state missing", 403)
		return
	}
	token := r.PostForm.Get("ticket")
	s.tunnels.mu.Lock()
	s.tunnels.pruneLocked()
	grant, ok := s.tunnels.tickets[accounts.HashToken(token)]
	delete(s.tunnels.tickets, accounts.HashToken(token))
	s.tunnels.mu.Unlock()
	if !ok || grant.TunnelID != id || grant.State != state.Value || time.Now().After(grant.Expires) {
		http.Error(w, "login exchange expired or used", 403)
		return
	}
	if _, _, ok = s.validPreviewGrant(r.Context(), grant); !ok {
		http.Error(w, "service access revoked", 403)
		return
	}
	clearOtherAppCookieAudiences(w, r, previewAppCookieAudience(grant))
	grant.Expires = time.Now().Add(8 * time.Hour)
	grant.State = ""
	session := tunnelRandom()
	s.tunnels.mu.Lock()
	s.tunnels.pruneLocked()
	if s.tunnels.stopped || len(s.tunnels.grants) >= 8192 {
		s.tunnels.mu.Unlock()
		http.Error(w, "preview login capacity reached", 503)
		return
	}
	s.tunnels.grants[accounts.HashToken(session)] = grant
	s.tunnels.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: previewCookie, Value: session, Secure: true, HttpOnly: true, Path: "/", SameSite: http.SameSiteLaxMode, MaxAge: 8 * 3600})
	http.SetCookie(w, &http.Cookie{Name: previewStateCookie, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteNoneMode, MaxAge: -1})
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

// An anonymous deep link explains the normal Foundry login flow. No app page
// ever receives the control session, and the retry URL contains no ticket.
func (s *Server) previewSignInRequired(w http.ResponseWriter, r *http.Request) bool {
	prefix := "/api/service-tunnels/"
	if r.Method != "GET" || !strings.HasPrefix(r.URL.Path, prefix) || !strings.HasSuffix(r.URL.Path, "/authorize") || !strings.Contains(r.Header.Get("Accept"), "text/html") {
		return false
	}
	id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, prefix), "/authorize")
	if !serviceTunnelID.MatchString(id) || s.previewDomain() == "" {
		return false
	}
	previewHeaders(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
	w.WriteHeader(401)
	page := template.Must(template.New("sign-in").Parse(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Foundry sign-in required</title></head><body><h1>Sign in to Foundry / 登录 Foundry</h1><p><a href="{{.Login}}" target="_blank" rel="noopener noreferrer">Sign in / 登录</a></p><p>After signing in, <a href="{{.Service}}">open this service / 登录后打开此服务</a>.</p></body></html>`))
	_ = page.Execute(w, map[string]string{"Login": s.options.AllowedOrigin, "Service": "https://" + id + "." + s.previewDomain()})
	return true
}
