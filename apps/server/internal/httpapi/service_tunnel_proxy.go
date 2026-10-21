package httpapi

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) proxyServiceTunnel(w http.ResponseWriter, r *http.Request, item store.ServiceTunnel, control *daemonConnection, grant previewGrant) {
	if r.Method == "CONNECT" || r.Method == "TRACE" || (r.Header.Get("Upgrade") != "" && !strings.EqualFold(r.Header.Get("Upgrade"), "websocket")) {
		http.Error(w, "unsupported service protocol", 400)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<20)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	r = r.WithContext(ctx)
	conn, cleanup, err := s.openServiceStream(ctx, item, control)
	if err != nil {
		http.Error(w, err.Error(), 503)
		return
	}
	defer cleanup()
	defer conn.Close()
	// Every open request/WS is bounded by current authority. No fixed response
	// timeout truncates SSE/downloads; revocation closes idle upgraded sockets too.
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_, current, ok := s.validPreviewGrant(ctx, grant)
				if !ok || current != control {
					_ = conn.Close()
					cancel()
					return
				}
			}
		}
	}()
	target := &url.URL{Scheme: item.Protocol, Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(item.Port))}
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true, ForceAttemptHTTP2: false, ResponseHeaderTimeout: 30 * time.Second, MaxResponseHeaderBytes: 1 << 20, TLSHandshakeTimeout: 10 * time.Second,
		DialContext: func(context.Context, string, string) (net.Conn, error) { return conn, nil }}
	defer transport.CloseIdleConnections()
	proxy := httputil.ReverseProxy{Transport: transport, FlushInterval: -1, ErrorLog: log.New(io.Discard, "", 0),
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.Host = target.Host
			stripTunnelHeaders(pr.Out.Header, pr.Out.URL.EscapedPath(), previewAppCookieAudience(grant))
			pr.Out.Header.Set("X-Forwarded-Host", r.Host)
			pr.Out.Header.Set("X-Forwarded-Proto", "https")
			// The browser's exact application origin was checked before proxying.
			if pr.In.Header.Get("Origin") != "" {
				pr.Out.Header.Set("Origin", target.String())
			}
			if ref, err := url.Parse(pr.In.Header.Get("Referer")); err == nil && ref.Host == r.Host {
				ref.Scheme = target.Scheme
				ref.Host = target.Host
				pr.Out.Header.Set("Referer", ref.String())
			} else {
				pr.Out.Header.Del("Referer")
			}
		},
		ModifyResponse: func(response *http.Response) error {
			return rewriteTunnelResponse(response, target, "https://"+r.Host, previewAppCookieAudience(grant))
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			http.Error(w, "local web service unavailable", http.StatusBadGateway)
		},
	}
	_ = http.NewResponseController(w).EnableFullDuplex()
	proxy.ServeHTTP(tunnelResponseWriter{w}, r)
}
func stripTunnelHeaders(h http.Header, requestPath string, audience ...string) {
	for key := range h {
		lower := strings.ToLower(key)
		if strings.HasPrefix(lower, "x-foundry-") || strings.HasPrefix(lower, "x-forwarded-") || lower == "forwarded" || lower == "authorization" || lower == "proxy-authorization" {
			h.Del(key)
		}
	}
	request := &http.Request{Header: h.Clone()}
	h.Del("Cookie")
	cookies := []*http.Cookie{}
	for _, cookie := range request.Cookies() {
		if app := unscopedAppCookie(cookie, requestPath, audience...); app != nil {
			cookies = append(cookies, app)
		}
	}
	// All browser-side encoded cookies have Path=/; restore original RFC path
	// precedence so same-name session cookies do not change application semantics.
	sort.SliceStable(cookies, func(i, j int) bool { return len(cookies[i].Path) > len(cookies[j].Path) })
	for _, cookie := range cookies {
		request := &http.Request{Header: h}
		request.AddCookie(cookie)
	}

}
func rewriteTunnelResponse(r *http.Response, target *url.URL, preview string, audience ...string) error {
	// Origin cookies become host-only, and cannot replace proxy credentials.
	cookies := r.Cookies()
	r.Header.Del("Set-Cookie")
	for _, cookie := range cookies {
		if cookie.Name == previewCookie || cookie.Name == previewStateCookie || cookie.Name == sessionCookieName || strings.HasPrefix(cookie.Name, "__Host-foundry") {
			continue
		}
		requestPath := "/"
		if r.Request != nil {
			requestPath = r.Request.URL.EscapedPath()
		}
		r.Header.Add("Set-Cookie", scopeAppCookie(cookie, requestPath, audience...).String())
	}
	// Never let an upstream choose the browser's tunnel/control-plane authority.
	r.Header.Del("Clear-Site-Data")
	r.Header.Del("Service-Worker-Allowed")
	r.Header.Del("Access-Control-Allow-Origin")
	r.Header.Del("Access-Control-Allow-Credentials")
	r.Header.Set("Cache-Control", "no-store")
	r.Header.Set("Referrer-Policy", "same-origin")
	r.Header.Set("Cross-Origin-Opener-Policy", "same-origin")
	r.Header.Set("Origin-Agent-Cluster", "?1")
	r.Header.Set("Permissions-Policy", "document-domain=()")
	r.Header.Add("Content-Security-Policy", "worker-src 'none'; frame-ancestors 'self'")
	location := r.Header.Get("Location")
	if location != "" {
		if strings.Contains(location, "\\") || strings.HasPrefix(location, "///") {
			return errors.New("ambiguous redirect slashes refused")
		}
		parsed, err := url.Parse(location)
		if err != nil {
			return errors.New("invalid local redirect")
		}
		if parsed.User != nil {
			return errors.New("redirect credentials refused")
		}
		if parsed.Host != "" {
			if parsed.Host == target.Host || parsed.Host == "localhost:"+target.Port() {
				parsed.Scheme = "https"
				parsed.Host = strings.TrimPrefix(preview, "https://")
				r.Header.Set("Location", parsed.String())
			} else if parsed.Scheme+"://"+parsed.Host != preview {
				return errors.New("redirect outside registered application refused")
			}
		} else if parsed.Scheme != "" {
			return errors.New("redirect scheme refused")
		}
	}
	return nil
}
