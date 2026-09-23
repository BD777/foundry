package main

import (
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
	if cfg.DBPath != ".data/foundry.db" {
		t.Fatalf("DBPath = %q, want .data/foundry.db", cfg.DBPath)
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
