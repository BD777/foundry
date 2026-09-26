package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLoadConfigDefaults(t *testing.T) {
	cfg := loadConfig(func(string) string { return "" })

	if cfg.Host != "127.0.0.1" {
		t.Fatalf("Host = %q, want loopback default", cfg.Host)
	}
	if cfg.Addr != "127.0.0.1:31982" {
		t.Fatalf("Addr = %q, want 127.0.0.1:31982", cfg.Addr)
	}
	home, _ := os.UserHomeDir()
	if want := filepath.Join(home, ".foundry", "server", "foundry.db"); cfg.DBPath != want {
		t.Fatalf("DBPath = %q, want %q (outside any checkout)", cfg.DBPath, want)
	}
	if cfg.LegacyDBPath != filepath.Join(".data", "foundry.db") {
		t.Fatalf("LegacyDBPath = %q, want the old in-checkout default", cfg.LegacyDBPath)
	}
	if cfg.Options.AllowedOrigin != "http://127.0.0.1:31983" {
		t.Fatalf("AllowedOrigin = %q, want http://127.0.0.1:31983", cfg.Options.AllowedOrigin)
	}
	if cfg.Options.EnableDevReset {
		t.Fatal("EnableDevReset = true, want disabled by default")
	}
	if cfg.SeedDemo {
		t.Fatal("SeedDemo = true, want disabled by default")
	}
	if cfg.ShutdownTimeout <= 0 {
		t.Fatalf("ShutdownTimeout = %v, want a bounded positive budget", cfg.ShutdownTimeout)
	}
}

func TestLoadConfigReadsEnvironmentContract(t *testing.T) {
	env := map[string]string{
		"FOUNDRY_HOST":             "0.0.0.0",
		"PORT":                     "41982",
		"FOUNDRY_DB_PATH":          "/tmp/foundry-test.db",
		"FOUNDRY_WEB_ORIGIN":       "https://foundry.example",
		"FOUNDRY_CONTROL_TOKEN":    "control-secret",
		"FOUNDRY_PAIRING_CODE":     "pair-secret",
		"FOUNDRY_ENABLE_DEV_RESET": "1",
		"FOUNDRY_DEMO_SEED":        "1",
	}
	cfg := loadConfig(func(key string) string { return env[key] })

	if cfg.Addr != "0.0.0.0:41982" {
		t.Fatalf("Addr = %q, want 0.0.0.0:41982", cfg.Addr)
	}
	if cfg.DBPath != "/tmp/foundry-test.db" {
		t.Fatalf("DBPath = %q, want the overridden path", cfg.DBPath)
	}
	if cfg.Options.AllowedOrigin != "https://foundry.example" {
		t.Fatalf("AllowedOrigin = %q, want the overridden origin", cfg.Options.AllowedOrigin)
	}
	if len(cfg.RetiredSettings) != 2 || cfg.RetiredSettings[0] != "FOUNDRY_CONTROL_TOKEN" || cfg.RetiredSettings[1] != "FOUNDRY_PAIRING_CODE" {
		t.Fatalf("RetiredSettings = %v, want the set control token and pairing code reported", cfg.RetiredSettings)
	}
	if err := validateSettings(cfg); err == nil || !strings.Contains(err.Error(), "FOUNDRY_CONTROL_TOKEN") {
		t.Fatalf("validateSettings must refuse a retired setting, got %v", err)
	}
	if !cfg.Options.EnableDevReset || !cfg.SeedDemo {
		t.Fatal("dev reset and demo seed should be enabled by their opt-in flags")
	}
}

func TestLoadConfigJoinsIPv6Host(t *testing.T) {
	cfg := loadConfig(func(key string) string {
		if key == "FOUNDRY_HOST" {
			return "::1"
		}
		return ""
	})

	if cfg.Addr != "[::1]:31982" {
		t.Fatalf("Addr = %q, want bracketed IPv6 address", cfg.Addr)
	}
}

func TestNewHTTPServerLimitsHeadersWithoutStreamingDeadlines(t *testing.T) {
	cfg := loadConfig(func(string) string { return "" })
	httpServer := newHTTPServer(cfg, nil)

	if httpServer.Addr != cfg.Addr {
		t.Fatalf("Addr = %q, want %q", httpServer.Addr, cfg.Addr)
	}
	if httpServer.ReadHeaderTimeout != readHeaderTimeout || httpServer.ReadHeaderTimeout <= 0 {
		t.Fatalf("ReadHeaderTimeout = %v, want %v", httpServer.ReadHeaderTimeout, readHeaderTimeout)
	}
	if httpServer.IdleTimeout != idleTimeout || httpServer.IdleTimeout <= 0 {
		t.Fatalf("IdleTimeout = %v, want %v", httpServer.IdleTimeout, idleTimeout)
	}
	if httpServer.MaxHeaderBytes != maxHeaderBytes {
		t.Fatalf("MaxHeaderBytes = %d, want %d", httpServer.MaxHeaderBytes, maxHeaderBytes)
	}
	// SSE responses and hijacked WebSocket sessions outlive any whole-request
	// budget, so these must stay unset.
	if httpServer.ReadTimeout != time.Duration(0) {
		t.Fatalf("ReadTimeout = %v, want 0 so SSE and WebSocket sessions are not cut off", httpServer.ReadTimeout)
	}
	if httpServer.WriteTimeout != time.Duration(0) {
		t.Fatalf("WriteTimeout = %v, want 0 so SSE and WebSocket sessions are not cut off", httpServer.WriteTimeout)
	}
}

func TestDefaultDBPathFollowsTheWorkerStateRoot(t *testing.T) {
	env := func(values map[string]string) func(string) string {
		return func(key string) string { return values[key] }
	}
	cases := []struct {
		name   string
		values map[string]string
		want   string
	}{
		{"default stack", map[string]string{"HOME": "/h"}, "/h/.foundry/server/foundry.db"},
		{"named stack", map[string]string{"HOME": "/h", "FOUNDRY_STACK": "lab"}, "/h/.foundry-stacks/lab/server/foundry.db"},
		{"explicit state root", map[string]string{"HOME": "/h", "FOUNDRY_STACK": "lab", "FOUNDRY_STATE_ROOT": "/s"}, "/s/server/foundry.db"},
	}
	for _, c := range cases {
		if got := loadConfig(env(c.values)).DBPath; got != c.want {
			t.Errorf("%s: DBPath = %q, want %q", c.name, got, c.want)
		}
	}
	explicit := loadConfig(env(map[string]string{"FOUNDRY_DB_PATH": "/data/foundry.db"}))
	if explicit.DBPath != "/data/foundry.db" || explicit.LegacyDBPath != "" {
		t.Fatalf("explicit path: DBPath=%q LegacyDBPath=%q", explicit.DBPath, explicit.LegacyDBPath)
	}
}

func TestDataLocationRefusesAnEmptyNewDefaultWhileOldDataExists(t *testing.T) {
	cfg := config{DBPath: "/state/server/foundry.db", LegacyDBPath: ".data/foundry.db"}
	on := func(paths ...string) func(string) bool {
		return func(path string) bool {
			for _, p := range paths {
				if p == path {
					return true
				}
			}
			return false
		}
	}
	err := checkDataLocation(cfg, on(".data/foundry.db"))
	if err == nil || !strings.Contains(err.Error(), "FOUNDRY_DB_PATH=") || !strings.Contains(err.Error(), "mv ") {
		t.Fatalf("old data only: err = %v, want refusal with move and override guidance", err)
	}
	for name, exists := range map[string]func(string) bool{
		"fresh install":     on(),
		"already migrated":  on("/state/server/foundry.db", ".data/foundry.db"),
		"new location only": on("/state/server/foundry.db"),
	} {
		if err := checkDataLocation(cfg, exists); err != nil {
			t.Errorf("%s: unexpected refusal %v", name, err)
		}
	}
	explicit := config{DBPath: "/data/foundry.db"}
	if err := checkDataLocation(explicit, on(".data/foundry.db")); err != nil {
		t.Errorf("explicit FOUNDRY_DB_PATH must never be refused: %v", err)
	}
}
