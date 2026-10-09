package main

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestHelpAndUnknownArgumentsNeverOpenTheDatabase(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "server", "foundry.db")
	t.Setenv("FOUNDRY_DB_PATH", dbPath)
	deps := defaultDependencies()
	deps.getenv = func(key string) string {
		if key == "FOUNDRY_DB_PATH" {
			return dbPath
		}
		return ""
	}
	deps.listen = func(context.Context, string) (net.Listener, error) {
		return nil, errors.New("tests never bind a port")
	}
	openStore := deps.openStore
	deps.openStore = func(cfg config) (store.Store, error) {
		t.Errorf("store opened at %s", cfg.DBPath)
		return openStore(cfg)
	}

	cases := []struct {
		args       []string
		code       int
		wantStdout string
		wantStderr string
	}{
		{args: []string{"--help"}, code: 0, wantStdout: "usage: foundry-server"},
		{args: []string{"-h"}, code: 0, wantStdout: "usage: foundry-server"},
		{args: []string{"help"}, code: 0, wantStdout: "usage: foundry-server"},
		{args: []string{"--port=1"}, code: 2, wantStderr: `unknown argument "--port=1"`},
		{args: []string{"serve"}, code: 2, wantStderr: "usage: foundry-server"},
		{args: []string{"users", "--help"}, code: 0},
		{args: []string{"users", "bogus"}, code: 1, wantStderr: `unknown subcommand "bogus"`},
		{args: []string{"users", "create", "--help"}, code: 0},
		{args: []string{"users", "create", "--bogus"}, code: 1},
		{args: []string{"users", "create", "--username", "admin", "--role", "owner"}, code: 1},
		{args: []string{"users", "reset-password", "--bogus"}, code: 1},
		{args: []string{"keys", "--help"}, code: 0},
		{args: []string{"keys", "generate", "--bogus"}, code: 1},
		{args: []string{"devices", "--help"}, code: 0},
		{args: []string{"devices", "pairing-token", "--bogus"}, code: 1},
	}
	for _, tc := range cases {
		var stdout, stderr strings.Builder
		code := runCommand(context.Background(), tc.args, deps, strings.NewReader(""), &stdout, &stderr)
		if code != tc.code {
			t.Errorf("%v exit code = %d, want %d (stderr %q)", tc.args, code, tc.code, stderr.String())
		}
		if !strings.Contains(stdout.String(), tc.wantStdout) {
			t.Errorf("%v stdout = %q, want %q", tc.args, stdout.String(), tc.wantStdout)
		}
		if !strings.Contains(stderr.String(), tc.wantStderr) {
			t.Errorf("%v stderr = %q, want %q", tc.args, stderr.String(), tc.wantStderr)
		}
		if _, err := os.Stat(filepath.Dir(dbPath)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%v touched the database directory (stat err %v)", tc.args, err)
		}
	}

	// A real subcommand still reaches the configured database.
	var stdout, stderr strings.Builder
	if code := runCommand(context.Background(), []string{"users", "list"}, deps, strings.NewReader(""), &stdout, &stderr); code != 0 {
		t.Fatalf("users list exit code = %d (stderr %q)", code, stderr.String())
	}
	if _, err := os.Stat(dbPath); err != nil {
		t.Fatalf("users list did not open %s: %v", dbPath, err)
	}
}
