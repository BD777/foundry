package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/secretstore"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func keysEnv(t *testing.T) (env func(string) string, dbPath string, keyPath string) {
	t.Helper()
	dir := t.TempDir()
	dbPath = filepath.Join(dir, "foundry.db")
	keyPath = filepath.Join(dir, "foundry-secret.key")
	env = func(key string) string {
		switch key {
		case "FOUNDRY_DB_PATH":
			return dbPath
		case "FOUNDRY_SECRET_KEY_PATH":
			return keyPath
		default:
			return ""
		}
	}
	return env, dbPath, keyPath
}

func captureKeys(t *testing.T, env func(string) string, args ...string) string {
	t.Helper()
	var out strings.Builder
	original := os.Stdout
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = writer
	runErr := runKeys(args, env)
	writer.Close()
	os.Stdout = original
	buf := make([]byte, 4096)
	n, _ := reader.Read(buf)
	out.Write(buf[:n])
	if runErr != nil {
		t.Fatalf("keys %v failed: %v", args, runErr)
	}
	return out.String()
}

func TestKeysGenerateFingerprintAndRotate(t *testing.T) {
	env, dbPath, keyPath := keysEnv(t)

	first := captureKeys(t, env, "generate")
	if !strings.Contains(first, "fingerprint sha256:") {
		t.Fatalf("generate output lacks fingerprint: %q", first)
	}
	if err := runKeys([]string{"generate"}, env); err == nil {
		t.Fatal("second generate without --force unexpectedly succeeded")
	}

	// Seed one secret through the real store path.
	st, err := sqlitestore.OpenWithOptions(dbPath, sqlitestore.Options{SecretKeyPath: keyPath})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.PutSecret(context.Background(), "agent-profile:prof_1", []byte("relay-key"), "agent-profile:prof_1"); err != nil {
		t.Fatal(err)
	}
	before, err := secretstore.LoadKEK(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	st.Close()

	rotated := captureKeys(t, env, "rotate")
	if !strings.Contains(rotated, before.Fingerprint) || !strings.Contains(rotated, "re-wrapped 1 secret(s)") {
		t.Fatalf("rotate output missing fingerprints or count: %q", rotated)
	}
	after, err := secretstore.LoadKEK(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if after.Fingerprint == before.Fingerprint {
		t.Fatal("rotate did not replace the key file")
	}
	reopened, err := sqlitestore.OpenWithOptions(dbPath, sqlitestore.Options{SecretKeyPath: keyPath})
	if err != nil {
		t.Fatalf("reopen after rotate: %v", err)
	}
	defer reopened.Close()
	got, err := reopened.GetSecret(context.Background(), "agent-profile:prof_1")
	if err != nil || string(got) != "relay-key" {
		t.Fatalf("secret after CLI rotation = %q, %v", got, err)
	}

	printed := captureKeys(t, env, "fingerprint")
	if !strings.Contains(printed, after.Fingerprint) {
		t.Fatalf("fingerprint output stale: %q", printed)
	}
}

func TestKeysReinitializeRequiresExplicitDataLossAcceptance(t *testing.T) {
	env, dbPath, keyPath := keysEnv(t)
	if err := runKeys([]string{"generate"}, env); err != nil {
		t.Fatal(err)
	}
	st, err := sqlitestore.OpenWithOptions(dbPath, sqlitestore.Options{SecretKeyPath: keyPath})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.PutSecret(context.Background(), "agent-profile:prof_1", []byte("relay-key"), "agent-profile:prof_1"); err != nil {
		t.Fatal(err)
	}
	st.Close()

	if err := runKeys([]string{"reinitialize"}, env); err == nil {
		t.Fatal("reinitialize without --accept-data-loss unexpectedly succeeded")
	}
	output := captureKeys(t, env, "reinitialize", "--accept-data-loss")
	if !strings.Contains(output, "all stored secrets discarded") {
		t.Fatalf("reinitialize output lacks disclosure: %q", output)
	}
	reopened, err := sqlitestore.OpenWithOptions(dbPath, sqlitestore.Options{SecretKeyPath: keyPath})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if _, err := reopened.GetSecret(context.Background(), "agent-profile:prof_1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("secret survived reinitialize: %v", err)
	}
}

func TestKeysFailsWithoutKeyFile(t *testing.T) {
	env, _, _ := keysEnv(t)
	if err := runKeys([]string{"fingerprint"}, env); err == nil {
		t.Fatal("fingerprint without a key file unexpectedly succeeded")
	}
	if err := runKeys([]string{"bogus"}, env); err == nil {
		t.Fatal("unknown subcommand unexpectedly succeeded")
	}
	if err := runKeys(nil, env); err == nil {
		t.Fatal("missing subcommand unexpectedly succeeded")
	}
}
