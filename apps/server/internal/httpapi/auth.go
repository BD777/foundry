package httpapi

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/accounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	sessionCookieName = "foundry_session"
	sessionTTL        = 30 * 24 * time.Hour
	// Sessions slide at most once a day so polling does not write on every
	// request.
	sessionRefreshWindow = sessionTTL - 24*time.Hour
	inviteDefaultTTL     = 7 * 24 * time.Hour
	inviteMaxTTL         = 30 * 24 * time.Hour
)

// Public auth endpoints are the only API routes reachable without a session.
func isPublicAuthRoute(r *http.Request) bool {
	path := r.URL.Path
	switch {
	case r.Method == http.MethodGet && path == "/api/auth/state":
		return true
	case r.Method == http.MethodPost && (path == "/api/auth/login" || path == "/api/auth/logout" || path == "/api/auth/setup"):
		return true
	case strings.HasPrefix(path, "/api/auth/invites/"):
		return true
	}
	return false
}

// initAccounts binds the account store and prepares the one-time setup code
// while no account exists. A store without accounts leaves every browser
// route closed.
func (s *Server) initAccounts() {
	accountStore, ok := s.store.(store.AccountStore)
	if !ok {
		log.Printf("store does not support accounts; browser API access is disabled")
		return
	}
	s.accounts = accountStore
	count, err := accountStore.CountUsers(context.Background())
	if err != nil {
		log.Printf("count users: %v", err)
		return
	}
	if count == 0 {
		code, err := accounts.NewSetupCode()
		if err != nil {
			log.Printf("generate setup code: %v", err)
			return
		}
		s.setupCode = code
	}
}

// SetupCode returns the pending first-owner setup code, or "" once an owner
// exists.
func (s *Server) SetupCode() string {
	s.setupMu.Lock()
	defer s.setupMu.Unlock()
	return s.setupCode
}

// setupPending reports whether first-owner setup is still open. An owner
// created out of band (foundry-server users create) closes it.
func (s *Server) setupPending(ctx context.Context) bool {
	s.setupMu.Lock()
	defer s.setupMu.Unlock()
	if s.setupCode == "" || s.accounts == nil {
		return false
	}
	if count, err := s.accounts.CountUsers(ctx); err == nil && count > 0 {
		s.setupCode = ""
		return false
	}
	return true
}

// authenticateAccount resolves the session cookie. It returns handled=true
// after writing a response itself.
func (s *Server) authenticateAccount(w http.ResponseWriter, r *http.Request) (*store.User, bool) {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil || cookie.Value == "" || s.accounts == nil {
		return nil, false
	}
	now := time.Now().UTC()
	user, extended, err := s.accounts.ResolveUserSession(r.Context(), accounts.HashToken(cookie.Value),
		now, now.Add(sessionRefreshWindow), now.Add(sessionTTL))
	if err != nil {
		if !errors.Is(err, store.ErrUserSessionInvalid) {
			writeError(w, http.StatusInternalServerError, "resolve login session")
			return nil, true
		}
		s.clearSessionCookie(w)
		return nil, false
	}
	if extended {
		s.setSessionCookie(w, cookie.Value, now.Add(sessionTTL))
	}
	return &user, false
}

// sameOriginWrite guards cookie-authenticated state changes: browsers always
// send Origin on non-GET fetches, and withCORS has already rejected foreign
// origins, so a missing Origin means a non-browser or forged request.
func (s *Server) sameOriginWrite(r *http.Request) bool {
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	}
	origin := normalizeOrigin(r.Header.Get("Origin"))
	return origin != "" && origin == s.options.AllowedOrigin
}

func (s *Server) setSessionCookie(w http.ResponseWriter, token string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/",
		Expires:  expires,
		MaxAge:   int(time.Until(expires).Seconds()),
		HttpOnly: true,
		Secure:   strings.HasPrefix(s.options.AllowedOrigin, "https://"),
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Server) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   strings.HasPrefix(s.options.AllowedOrigin, "https://"),
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request, user store.User) bool {
	token, err := accounts.NewToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create login session")
		return false
	}
	expires := time.Now().UTC().Add(sessionTTL)
	if err := s.accounts.CreateUserSession(r.Context(), user.ID, accounts.HashToken(token), expires); err != nil {
		writeError(w, http.StatusInternalServerError, "create login session")
		return false
	}
	s.setSessionCookie(w, token, expires)
	return true
}

// humanActor attributes a human action to the logged-in account, or to the
// single local operator when accounts are not in use. Request bodies can
// never set it.
func humanActor(r *http.Request) store.ActorRef {
	if account := actorFromContext(r.Context()).Account; account != nil {
		return store.ActorRef{Kind: "user", ID: account.ID, DisplayName: account.DisplayName}
	}
	return localOwnerActor()
}

// clientIP trusts X-Real-IP only from a loopback peer (the local reverse
// proxy); otherwise the socket address is used.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		if forwarded := strings.TrimSpace(r.Header.Get("X-Real-IP")); forwarded != "" {
			return forwarded
		}
	}
	return host
}

// loginLimiter locks a key (username or client IP) for lockDuration after
// maxFailures failed attempts inside window.
type loginLimiter struct {
	mu           sync.Mutex
	entries      map[string]*loginAttempts
	maxFailures  int
	window       time.Duration
	lockDuration time.Duration
	now          func() time.Time
}

type loginAttempts struct {
	failures    int
	windowStart time.Time
	lockedUntil time.Time
}

const loginLimiterMaxEntries = 10000

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{
		entries:      map[string]*loginAttempts{},
		maxFailures:  5,
		window:       15 * time.Minute,
		lockDuration: 15 * time.Minute,
		now:          time.Now,
	}
}

// locked reports whether any key is currently locked out.
func (l *loginLimiter) locked(keys ...string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	for _, key := range keys {
		if entry, ok := l.entries[key]; ok && now.Before(entry.lockedUntil) {
			return true
		}
	}
	return false
}

func (l *loginLimiter) fail(keys ...string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if len(l.entries) >= loginLimiterMaxEntries {
		for key, entry := range l.entries {
			if now.Sub(entry.windowStart) > l.window && now.After(entry.lockedUntil) {
				delete(l.entries, key)
			}
		}
	}
	for _, key := range keys {
		entry, ok := l.entries[key]
		if !ok || now.Sub(entry.windowStart) > l.window {
			entry = &loginAttempts{windowStart: now}
			l.entries[key] = entry
		}
		entry.failures++
		if entry.failures >= l.maxFailures {
			entry.lockedUntil = now.Add(l.lockDuration)
			entry.failures = 0
			entry.windowStart = now
		}
	}
}

func (l *loginLimiter) succeed(keys ...string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, key := range keys {
		delete(l.entries, key)
	}
}
