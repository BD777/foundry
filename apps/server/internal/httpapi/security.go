package httpapi

import (
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	defaultWebOrigin              = "http://127.0.0.1:31983"
	deviceCredentialHeader        = "X-Foundry-Device-Credential"
	defaultAgentSessionStaleAfter = 30 * time.Minute
)

type ServerOptions struct {
	AgentSessionStaleAfter time.Duration
	AllowedOrigin          string
	EnableDevReset         bool
	// WebDistDir, when non-empty, serves the built web app from the
	// directory and enables SPA fallback. Empty keeps the API-only
	// behaviour used by the Vite development server.
	WebDistDir string
}

func DefaultServerOptions() ServerOptions {
	return ServerOptions{
		AgentSessionStaleAfter: defaultAgentSessionStaleAfter,
		AllowedOrigin:          defaultWebOrigin,
	}
}

func normalizeServerOptions(options ServerOptions) ServerOptions {
	options.AllowedOrigin = normalizeOrigin(options.AllowedOrigin)
	if options.AllowedOrigin == "" {
		options.AllowedOrigin = defaultWebOrigin
	}
	if options.AgentSessionStaleAfter <= 0 {
		options.AgentSessionStaleAfter = defaultAgentSessionStaleAfter
	}
	return options
}

func (s *Server) withAuthentication(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}

		// Worker devices authenticate with their own credential, on daemon
		// routes and on the browser routes the local worker and CLI call.
		// Pairing is how a device obtains one, so it is the only daemon route
		// reachable without it.
		if credential := strings.TrimSpace(r.Header.Get(deviceCredentialHeader)); credential != "" {
			actor, ok := s.authenticateDevice(w, r, credential)
			if !ok {
				return
			}
			next.ServeHTTP(w, r.WithContext(actorInContext(r.Context(), actor)))
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/daemon/") {
			// Package tests act as a device that is not bound to one id.
			if s.testActor != nil {
				actor := Actor{Kind: ActorDaemon, Account: s.testActor.Account}
				next.ServeHTTP(w, r.WithContext(actorInContext(r.Context(), actor)))
				return
			}
			if r.Method == http.MethodPost && r.URL.Path == "/api/daemon/pair" {
				next.ServeHTTP(w, r)
				return
			}
			writeError(w, http.StatusUnauthorized, "device credential required; pair this worker first")
			return
		}

		// Session-scoped tokens (CHAT-01 MCP/CLI).
		if bearer := bearerToken(r); bearer != "" {
			identity, err := s.store.ResolveSessionToken(r.Context(), bearer)
			if err != nil {
				writeError(w, http.StatusUnauthorized, "valid token required")
				return
			}
			actor := Actor{Kind: ActorAgent, Identity: identity}
			next.ServeHTTP(w, r.WithContext(actorInContext(r.Context(), actor)))
			return
		}

		// Package tests run as an injected account; nothing outside the
		// package can set this field.
		if s.testActor != nil {
			next.ServeHTTP(w, r.WithContext(actorInContext(r.Context(), *s.testActor)))
			return
		}
		s.authenticateAccountRequest(w, r, next)
	})
}

// authenticateAccountRequest is the browser path: a session cookie identifies
// the account; everything else except the public auth routes is 401.
func (s *Server) authenticateAccountRequest(w http.ResponseWriter, r *http.Request, next http.Handler) {
	user, handled := s.authenticateAccount(w, r)
	if handled {
		return
	}
	public := isPublicAuthRoute(r)
	if user == nil && !public {
		writeError(w, http.StatusUnauthorized, "login required")
		return
	}
	if (user != nil || public) && !s.sameOriginWrite(r) {
		writeError(w, http.StatusForbidden, "cross-site request rejected")
		return
	}
	ctx := r.Context()
	if user != nil {
		ctx = actorInContext(ctx, Actor{Kind: ActorAccount, Account: user})
	}
	next.ServeHTTP(w, r.WithContext(ctx))
}

func bearerToken(r *http.Request) string {
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	const bearerPrefix = "Bearer "
	if len(header) >= len(bearerPrefix) && strings.EqualFold(header[:len(bearerPrefix)], bearerPrefix) {
		return strings.TrimSpace(header[len(bearerPrefix):])
	}
	// EventSource cannot set headers, mirroring the control-token exception.
	if r.Method == http.MethodGet && r.URL.Path == "/api/events" {
		return strings.TrimSpace(r.URL.Query().Get("access_token"))
	}
	return ""
}

func withCORS(allowedOrigin string, next http.Handler) http.Handler {
	allowedOrigin = normalizeOrigin(allowedOrigin)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rawOrigin := strings.TrimSpace(r.Header.Get("Origin"))
		origin := normalizeOrigin(rawOrigin)
		if rawOrigin != "" && (origin == "" || origin != allowedOrigin) {
			writeError(w, http.StatusForbidden, "origin is not allowed")
			return
		}
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Add("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, If-None-Match, Idempotency-Key")
		w.Header().Set("Access-Control-Allow-Methods", "DELETE,GET,POST,PUT,PATCH,OPTIONS")
		w.Header().Set("Access-Control-Expose-Headers", "ETag")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func webSocketOriginAllowed(allowedOrigin string, r *http.Request) bool {
	rawOrigin := strings.TrimSpace(r.Header.Get("Origin"))
	if rawOrigin == "" {
		return true
	}
	origin := normalizeOrigin(rawOrigin)
	return origin != "" && origin == normalizeOrigin(allowedOrigin)
}

func normalizeOrigin(input string) string {
	value := strings.TrimSpace(input)
	if value == "" {
		return ""
	}
	parsed, err := url.Parse(value)
	if err != nil ||
		parsed.Scheme == "" ||
		parsed.Host == "" ||
		parsed.User != nil ||
		(parsed.Path != "" && parsed.Path != "/") ||
		parsed.RawQuery != "" ||
		parsed.Fragment != "" {
		return ""
	}
	return strings.ToLower(parsed.Scheme + "://" + parsed.Host)
}
