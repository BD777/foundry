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
	Addr   string
	DBPath string
	// LegacyDBPath is the pre-2026-09-26 default (inside the checkout) when the
	// default location applies; empty when FOUNDRY_DB_PATH is set.
	LegacyDBPath    string
	Host            string
	SecretKeyPath   string
	Options         httpapi.ServerOptions
	SeedDemo        bool
	ShutdownTimeout time.Duration
	// RetiredSettings lists environment variables that are set but no longer
	// supported; startup refuses them rather than silently ignoring intent.
	RetiredSettings []string
}

// Accounts and per-device credentials are always required; these configured
// the anonymous mode, the shared browser token and the shared daemon code.
var retiredSettings = []string{"FOUNDRY_AUTH_MODE", "FOUNDRY_CONTROL_TOKEN", "FOUNDRY_PAIRING_CODE"}

// loadConfig resolves the environment contract through an injected lookup so
// callers and tests can supply values without mutating process state.
func loadConfig(getenv func(string) string) config {
	host := envOrDefault(getenv, "FOUNDRY_HOST", "127.0.0.1")
	port := envOrDefault(getenv, "PORT", "31982")
	dbPath := strings.TrimSpace(getenv("FOUNDRY_DB_PATH"))
	legacyDBPath := ""
	if dbPath == "" {
		dbPath = defaultDBPath(getenv)
		legacyDBPath = filepath.Join(".data", "foundry.db")
	}
	return config{
		Addr:         net.JoinHostPort(host, port),
		DBPath:       dbPath,
		LegacyDBPath: legacyDBPath,
		Host:         host,
		SecretKeyPath: envOrDefault(getenv, "FOUNDRY_SECRET_KEY_PATH",
			defaultSecretKeyPath(dbPath)),
		Options: httpapi.ServerOptions{
			AllowedOrigin:  envOrDefault(getenv, "FOUNDRY_WEB_ORIGIN", "http://127.0.0.1:31983"),
			EnableDevReset: getenv("FOUNDRY_ENABLE_DEV_RESET") == "1",
			WebDistDir:     getenv("FOUNDRY_WEB_DIST"),
		},
		SeedDemo:        getenv("FOUNDRY_DEMO_SEED") == "1",
		ShutdownTimeout: shutdownTimeout,
		RetiredSettings: setSettings(getenv, retiredSettings),
	}
}

func setSettings(getenv func(string) string, names []string) []string {
	var set []string
	for _, name := range names {
		if strings.TrimSpace(getenv(name)) != "" {
			set = append(set, name)
		}
	}
	return set
}

func validateSettings(cfg config) error {
	if len(cfg.RetiredSettings) > 0 {
		return fmt.Errorf("%s no longer supported: browsers sign in with accounts and workers pair with a one-time token; unset them",
			strings.Join(cfg.RetiredSettings, " and "))
	}
	return checkDataLocation(cfg, fileExists)
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

// checkDataLocation refuses to start on an empty new default while data still
// sits at the old default inside the checkout: silently creating a fresh
// database would look like lost data, and moving it is the operator's call.
func checkDataLocation(cfg config, exists func(string) bool) error {
	if cfg.LegacyDBPath == "" || exists(cfg.DBPath) || !exists(cfg.LegacyDBPath) {
		return nil
	}
	legacy, err := filepath.Abs(cfg.LegacyDBPath)
	if err != nil {
		legacy = cfg.LegacyDBPath
	}
	oldDir, newDir := filepath.Dir(legacy), filepath.Dir(cfg.DBPath)
	return fmt.Errorf("server data found at the old default %s and none at the new default %s; "+
		"move it out of the checkout with `mkdir -p -m 700 %s && mv %s/foundry.db* %s/foundry-secret.key %s/`, "+
		"or keep it in place with FOUNDRY_DB_PATH=%s",
		legacy, cfg.DBPath, newDir, oldDir, oldDir, newDir, legacy)
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
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
