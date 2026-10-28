package httpapi

import (
	"encoding/hex"
	"github.com/foundry-dev/foundry/apps/server/internal/accounts"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Browser API reads need an origin boundary too: SameSite cookies are sent
// from sibling application origins. Non-browser device/session-token clients
// are authenticated separately before this cookie-only gate.
func (s *Server) sameSiteAccountRequestAllowed(r *http.Request) bool {
	if raw := r.Header.Get("Origin"); raw != "" {
		return normalizeOrigin(raw) == s.options.AllowedOrigin
	}
	if r.Header.Get("Upgrade") != "" {
		return false
	}
	if r.Method != "GET" && r.Method != "HEAD" && r.Method != "OPTIONS" {
		return false
	}
	if r.Header.Get("Sec-Fetch-Site") == "same-origin" {
		return true
	}
	if r.Header.Get("Sec-Fetch-Mode") != "navigate" || r.Header.Get("Sec-Fetch-Dest") != "document" {
		return false
	}
	// Address-bar/bookmark navigation is an explicit user action. A sibling's
	// navigation has site=same-site and does not enter this branch.
	if r.Header.Get("Sec-Fetch-Site") == "none" {
		return true
	}
	if s.sameSiteOAuthCallbackAllowed(r) {
		return true
	}
	// This one GET creates only a nonce-bound, single-use POST exchange. The
	// receiver must prove its host-only browser state before acquiring a grant.
	id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/service-tunnels/"), "/authorize")
	state, err := hex.DecodeString(r.URL.Query().Get("state"))
	return r.Method == "GET" && r.URL.Path == "/api/service-tunnels/"+id+"/authorize" && serviceTunnelID.MatchString(id) && err == nil && len(state) == 32
}

func controlOriginHeaders(w http.ResponseWriter) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
	w.Header().Set("Origin-Agent-Cluster", "?1")
	w.Header().Set("Permissions-Policy", "document-domain=()")
	w.Header().Add("Content-Security-Policy", "frame-ancestors 'self'")
}

func (s *Server) routeSameSiteHost(w http.ResponseWriter, r *http.Request, control http.Handler) {
	origin, err := url.Parse(s.options.AllowedOrigin)
	if err != nil || origin.Scheme != "https" {
		http.Error(w, "HTTPS control origin required", 503)
		return
	}
	host := strings.ToLower(r.Host)
	if host == strings.ToLower(origin.Host) {
		controlOriginHeaders(w)
		control.ServeHTTP(w, r)
		return
	}
	// Local load-balancer health only; no API/static alias on the listener IP.
	peer, _, _ := net.SplitHostPort(r.RemoteAddr)
	localHost := r.Host
	if h, _, e := net.SplitHostPort(localHost); e == nil {
		localHost = h
	}
	if r.Method == "GET" && r.URL.Path == "/healthz" && net.ParseIP(peer).IsLoopback() && net.ParseIP(localHost).IsLoopback() {
		control.ServeHTTP(w, r)
		return
	}
	domain := s.previewDomain()
	if domain == "" || !strings.HasSuffix(host, "."+domain) {
		http.NotFound(w, r)
		return
	}
	label := strings.TrimSuffix(host, "."+domain)
	if s.answerPreviewProbe(w, r, label) {
		return
	}
	if !serviceHostLabel.MatchString(label) {
		http.NotFound(w, r)
		return
	}
	backing, err := s.tunnelStore()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	item, err := backing.GetServiceTunnelByHostLabel(r.Context(), label)
	if err != nil || s.tunnelHostname(item) != host {
		http.NotFound(w, r)
		return
	}
	s.serveServicePreview(w, r, item.ID)
}

// Connector callback exemption is deliberately optional and fails closed when
// the owning module has no state validator. The handler must independently
// revalidate and atomically consume this state before exchanging the code.
func (s *Server) sameSiteOAuthCallbackAllowed(r *http.Request) bool {
	if r.Method != "GET" || r.URL.Path != "/api/connectors/cloudflare/oauth/callback" || r.Header.Get("Sec-Fetch-Mode") != "navigate" || r.Header.Get("Sec-Fetch-Dest") != "document" || s.connectors == nil {
		return false
	}
	validator, ok := any(s.connectors.ServerHeld).(interface {
		AuthorizationCodeCallbackAllowed(string, string, string) bool
	})
	if !ok {
		return false
	}
	cookie, err := r.Cookie(s.accountCookieName())
	if err != nil {
		return false
	}
	user, _, err := s.store.ResolveUserSession(r.Context(), accounts.HashToken(cookie.Value), time.Now(), time.Time{}, time.Time{})
	if err != nil {
		return false
	}
	return validator.AuthorizationCodeCallbackAllowed(user.ID, r.URL.Query().Get("state"), r.URL.Query().Get("iss"))
}
