package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/httpapi"
	"github.com/foundry-dev/foundry/apps/server/internal/integrations"
)

const (
	// readHeaderTimeout bounds how long a client may take to send request
	// headers. It is deliberately the only read deadline we set: whole-request
	// deadlines would break server-sent events and hijacked WebSocket sessions.
	readHeaderTimeout = 10 * time.Second
	// idleTimeout closes keep-alive connections that never start a new request.
	// Active SSE and WebSocket connections are not idle, so they are unaffected.
	idleTimeout = 120 * time.Second
	// maxHeaderBytes caps header size per request.
	maxHeaderBytes = 1 << 20
	// shutdownTimeout bounds graceful drain before remaining connections
	// (long-lived SSE and WebSocket sessions included) are force-closed.
	shutdownTimeout = 15 * time.Second
)

// config is the resolved environment contract for one server process.
type config struct {
	Addr            string
	DBPath          string
	Host            string
	SecretKeyPath   string
	Options         httpapi.ServerOptions
	SeedDemo        bool
	ShutdownTimeout time.Duration
	// IntegrationsErr refuses a FOUNDRY_INTEGRATIONS value other than on/off.
	IntegrationsErr error
}

// loadConfig resolves the environment contract through an injected lookup so
// callers and tests can supply values without mutating process state.
func loadConfig(getenv func(string) string) config {
	host := envOrDefault(getenv, "FOUNDRY_HOST", "127.0.0.1")
	port := envOrDefault(getenv, "PORT", "31982")
	dbPath := strings.TrimSpace(getenv("FOUNDRY_DB_PATH"))
	if dbPath == "" {
		dbPath = defaultDBPath(getenv)
	}
	// The one place FOUNDRY_INTEGRATIONS is read; the server is handed the switch.
	integrationsSwitch, integrationsErr := integrations.Parse(getenv(integrations.Env))
	return config{
		Addr:   net.JoinHostPort(host, port),
		DBPath: dbPath,
		Host:   host,
		SecretKeyPath: envOrDefault(getenv, "FOUNDRY_SECRET_KEY_PATH",
			defaultSecretKeyPath(dbPath)),
		Options: httpapi.ServerOptions{
			PreviewDomain:     strings.TrimSpace(getenv("FOUNDRY_PREVIEW_DOMAIN")),
			PreviewSameSite:   getenv("FOUNDRY_PREVIEW_SAME_SITE") == "1",
			AllowedOrigin:     envOrDefault(getenv, "FOUNDRY_WEB_ORIGIN", "http://127.0.0.1:31983"),
			EnableDevReset:    getenv("FOUNDRY_ENABLE_DEV_RESET") == "1",
			WebDistDir:        getenv("FOUNDRY_WEB_DIST"),
			WorkerPackagesDir: strings.TrimSpace(getenv("FOUNDRY_WORKER_PACKAGES")),
			Integrations:      integrationsSwitch,
		},
		SeedDemo:        getenv("FOUNDRY_DEMO_SEED") == "1",
		ShutdownTimeout: shutdownTimeout,
		IntegrationsErr: integrationsErr,
	}
}

func validateSettings(cfg config) error {
	if cfg.Options.PreviewSameSite && !strings.HasPrefix(cfg.Options.AllowedOrigin, "https://") {
		return fmt.Errorf("FOUNDRY_PREVIEW_SAME_SITE requires an HTTPS FOUNDRY_WEB_ORIGIN")
	}
	return cfg.IntegrationsErr
}

// defaultDBPath keeps server data in Foundry's private state root, outside
// any checkout, so tools that serve or mount the repository never reach it.
// It follows the worker's state root: FOUNDRY_STATE_ROOT, else
// ~/.foundry-stacks/<FOUNDRY_STACK>, else ~/.foundry.
func defaultDBPath(getenv func(string) string) string {
	return filepath.Join(stateRoot(getenv), "server", "foundry.db")
}

func stateRoot(getenv func(string) string) string {
	if root := strings.TrimSpace(getenv("FOUNDRY_STATE_ROOT")); root != "" {
		return root
	}
	home := getenv("HOME")
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	if stack := strings.TrimSpace(getenv("FOUNDRY_STACK")); stack != "" {
		return filepath.Join(home, ".foundry-stacks", stack)
	}
	return filepath.Join(home, ".foundry")
}

// newHTTPServer builds the control-plane server with conservative header and
// idle limits. ReadTimeout and WriteTimeout stay unset on purpose so streaming
// endpoints can outlive any fixed whole-request budget.
func newHTTPServer(cfg config, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
		ReadHeaderTimeout: readHeaderTimeout,
	}
}

func envOrDefault(getenv func(string) string, key string, fallback string) string {
	value := getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

// defaultSecretKeyPath keeps the KEK beside the database so migrating a
// deployment is one directory copy and the key never lands in Git (.data/ is
// ignored). In-memory databases have no directory to own a key.
func defaultSecretKeyPath(dbPath string) string {
	if dbPath == ":memory:" {
		return ""
	}
	return filepath.Join(filepath.Dir(dbPath), "foundry-secret.key")
}
