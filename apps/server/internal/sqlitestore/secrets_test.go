package sqlitestore

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/secretstore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func secretPaths(t *testing.T) (dbPath string, keyPath string) {
	t.Helper()
	dir := t.TempDir()
	return filepath.Join(dir, "foundry.db"), filepath.Join(dir, "foundry-secret.key")
}

func TestOpenWithSecretKeyPathCreatesKeyAndCanary(t *testing.T) {
	dbPath, keyPath := secretPaths(t)
	s, err := OpenWithOptions(dbPath, Options{SecretKeyPath: keyPath})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	kek, err := secretstore.LoadKEK(keyPath)
	if err != nil {
		t.Fatalf("open did not create a key file: %v", err)
	}
	if info, err := os.Stat(keyPath); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("key file permission problem: %v %v", info, err)
	}
	if s.SecretKEKFingerprint() != kek.Fingerprint {
		t.Fatal("store fingerprint does not match the generated key file")
	}
	// Reopening with the same pair must verify rather than re-initialize.
	again, err := OpenWithOptions(dbPath, Options{SecretKeyPath: keyPath})
	if err != nil {
		t.Fatalf("reopen failed: %v", err)
	}
	defer again.Close()
	if again.SecretKEKFingerprint() != kek.Fingerprint {
		t.Fatal("reopen produced a different key fingerprint")
	}
}

func TestSecretPutGetDeleteRoundtrip(t *testing.T) {
	dbPath, keyPath := secretPaths(t)
	s, err := OpenWithOptions(dbPath, Options{SecretKeyPath: keyPath})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()

	if err := s.PutSecret(ctx, "agent-profile:prof_1", []byte("relay-key-1"), "agent-profile:prof_1"); err != nil {
		t.Fatal(err)
	}
	// Upsert overwrites.
	if err := s.PutSecret(ctx, "agent-profile:prof_1", []byte("relay-key-2"), "agent-profile:prof_1"); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetSecret(ctx, "agent-profile:prof_1")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "relay-key-2" {
		t.Fatalf("got %q, want the overwritten value", got)
	}
	if _, err := s.GetSecret(ctx, "agent-profile:missing"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing secret returned %v, want ErrNotFound", err)
	}
	if err := s.DeleteSecret(ctx, "agent-profile:prof_1"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetSecret(ctx, "agent-profile:prof_1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleted secret returned %v, want ErrNotFound", err)
	}
}

func TestOpenFailsClosedOnKeyMismatch(t *testing.T) {
	dbPath, keyPath := secretPaths(t)
	s, err := OpenWithOptions(dbPath, Options{SecretKeyPath: keyPath})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.PutSecret(context.Background(), "agent-profile:prof_1", []byte("value"), "agent-profile:prof_1"); err != nil {
		t.Fatal(err)
	}
	s.Close()

	stray, err := secretstore.GenerateKEK()
	if err != nil {
		t.Fatal(err)
	}
	if err := secretstore.WriteKEK(keyPath, stray, true); err != nil {
		t.Fatal(err)
	}
	_, err = OpenWithOptions(dbPath, Options{SecretKeyPath: keyPath})
	if !errors.Is(err, ErrSecretKeyMismatch) {
		t.Fatalf("mismatched key returned %v, want ErrSecretKeyMismatch", err)
	}
	if !strings.Contains(err.Error(), "reinitialize") {
		t.Fatalf("mismatch error lacks the recovery hint: %v", err)
	}

	// Losing the key entirely must fail the same way, not silently regenerate.
	os.Remove(keyPath)
	_, err = OpenWithOptions(dbPath, Options{SecretKeyPath: keyPath})
	if !errors.Is(err, ErrSecretKeyMismatch) {
		t.Fatalf("lost key returned %v, want ErrSecretKeyMismatch", err)
	}
}

func TestRotateSecretsRewrapsEverythingAtomically(t *testing.T) {
	dbPath, keyPath := secretPaths(t)
	s, err := OpenWithOptions(dbPath, Options{SecretKeyPath: keyPath})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	secrets := map[string]string{
		"agent-profile:prof_1": "relay-key-1",
		"agent-profile:prof_2": "relay-key-2",
	}
	for id, value := range secrets {
		if err := s.PutSecret(ctx, id, []byte(value), id); err != nil {
			t.Fatal(err)
		}
	}
	oldFingerprint := s.SecretKEKFingerprint()

	next, err := secretstore.GenerateKEK()
	if err != nil {
		t.Fatal(err)
	}
	rotated, err := s.RotateSecrets(ctx, next)
	if err != nil {
		t.Fatal(err)
	}
	if rotated != len(secrets) {
		t.Fatalf("rotated %d secrets, want %d", rotated, len(secrets))
	}
	if s.SecretKEKFingerprint() == oldFingerprint || s.SecretKEKFingerprint() != next.Fingerprint {
		t.Fatal("store did not adopt the rotated key")
	}
	for id, value := range secrets {
		got, err := s.GetSecret(ctx, id)
		if err != nil {
			t.Fatalf("after rotation %s: %v", id, err)
		}
		if string(got) != value {
			t.Fatalf("after rotation %s = %q, want %q", id, got, value)
		}
	}
	s.Close()

	// The old key file no longer opens the database.
	_, err = OpenWithOptions(dbPath, Options{SecretKeyPath: keyPath})
	if !errors.Is(err, ErrSecretKeyMismatch) {
		t.Fatalf("stale key file reopened the rotated database: %v", err)
	}
	if err := secretstore.WriteKEK(keyPath, next, true); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenWithOptions(dbPath, Options{SecretKeyPath: keyPath})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	for id, value := range secrets {
		got, err := reopened.GetSecret(ctx, id)
		if err != nil {
			t.Fatalf("reopened %s: %v", id, err)
		}
		if string(got) != value {
			t.Fatalf("reopened %s = %q, want %q", id, got, value)
		}
	}
}

func TestInterruptedRotationSelfHealsOnOpen(t *testing.T) {
	dbPath, keyPath := secretPaths(t)
	s, err := OpenWithOptions(dbPath, Options{SecretKeyPath: keyPath})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := s.PutSecret(ctx, "agent-profile:prof_1", []byte("relay-key"), "agent-profile:prof_1"); err != nil {
		t.Fatal(err)
	}
	next, err := secretstore.GenerateKEK()
	if err != nil {
		t.Fatal(err)
	}
	// Stage and rewrap but crash before promotion: no PromotePendingKEK call.
	if err := secretstore.WriteKEK(keyPath+".new", next, true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RotateSecrets(ctx, next); err != nil {
		t.Fatal(err)
	}
	s.Close()

	healed, err := OpenWithOptions(dbPath, Options{SecretKeyPath: keyPath})
	if err != nil {
		t.Fatalf("interrupted rotation did not self-heal: %v", err)
	}
	defer healed.Close()
	if healed.SecretKEKFingerprint() != next.Fingerprint {
		t.Fatal("self-heal did not adopt the staged key")
	}
	if _, err := os.Stat(keyPath + ".new"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("staged key survived self-heal")
	}
	got, err := healed.GetSecret(ctx, "agent-profile:prof_1")
	if err != nil || string(got) != "relay-key" {
		t.Fatalf("secret after self-heal = %q, %v", got, err)
	}
}

func TestResetSecretStoreDiscardsSecrets(t *testing.T) {
	dbPath, keyPath := secretPaths(t)
	s, err := OpenWithOptions(dbPath, Options{SecretKeyPath: keyPath})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := s.PutSecret(ctx, "agent-profile:prof_1", []byte("relay-key"), "agent-profile:prof_1"); err != nil {
		t.Fatal(err)
	}
	next, err := secretstore.GenerateKEK()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.ResetSecretStore(ctx, next); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetSecret(ctx, "agent-profile:prof_1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("reset left a secret behind: %v", err)
	}
	if s.SecretKEKFingerprint() != next.Fingerprint {
		t.Fatal("reset did not adopt the new key")
	}
}

func TestTamperedRowFailsClosedOnRead(t *testing.T) {
	dbPath, keyPath := secretPaths(t)
	s, err := OpenWithOptions(dbPath, Options{SecretKeyPath: keyPath})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	if err := s.PutSecret(ctx, "agent-profile:prof_1", []byte("relay-key"), "agent-profile:prof_1"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`UPDATE secret_records SET ciphertext = X'00010203' WHERE id = ?`, "agent-profile:prof_1"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetSecret(ctx, "agent-profile:prof_1"); err == nil {
		t.Fatal("tampered row decrypted successfully")
	}
}

func TestSecretStoreWithoutKeyPathIsDisabled(t *testing.T) {
	s, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.SecretKEKFingerprint() != "" {
		t.Fatal("memory store claims an active secret key")
	}
	if err := s.PutSecret(context.Background(), "id", []byte("v"), "id"); !errors.Is(err, ErrSecretStoreDisabled) {
		t.Fatalf("put without key path returned %v, want ErrSecretStoreDisabled", err)
	}
}

// Promotion moves a device-scoped credential to the server-profile id without
// asking the operator for the key again, so the plaintext has to survive the
// change of additional data that the new id implies.
func TestRenameSecretResealsUnderTheNewIdentity(t *testing.T) {
	dbPath, keyPath := secretPaths(t)
	s, err := OpenWithOptions(dbPath, Options{SecretKeyPath: keyPath})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()

	const oldID = "agent-profile:dev_1:prof_1"
	const newID = "agent-profile:prof_1"
	if err := s.PutSecret(ctx, oldID, []byte("relay-key"), oldID); err != nil {
		t.Fatal(err)
	}
	if err := s.RenameSecret(ctx, oldID, newID); err != nil {
		t.Fatalf("rename secret: %v", err)
	}

	got, err := s.GetSecret(ctx, newID)
	if err != nil {
		t.Fatalf("read renamed secret: %v", err)
	}
	if string(got) != "relay-key" {
		t.Fatalf("renamed secret holds %q, want the original plaintext", got)
	}
	var aad string
	if err := s.db.QueryRow(`SELECT aad FROM secret_records WHERE id = ?`, newID).Scan(&aad); err != nil {
		t.Fatal(err)
	}
	if aad != newID {
		t.Fatalf("renamed row kept additional data %q, want %q", aad, newID)
	}
	if _, err := s.GetSecret(ctx, oldID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("old secret id returned %v, want ErrNotFound", err)
	}
	if present, err := s.HasSecret(ctx, oldID); err != nil || present {
		t.Fatalf("old row still present (present=%v, err=%v)", present, err)
	}
}

func TestRenameSecretMissingRecordLeavesNothingBehind(t *testing.T) {
	dbPath, keyPath := secretPaths(t)
	s, err := OpenWithOptions(dbPath, Options{SecretKeyPath: keyPath})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()

	err = s.RenameSecret(ctx, "agent-profile:dev_1:ghost", "agent-profile:ghost")
	if !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("rename of a missing record returned %v, want ErrNotFound", err)
	}
	if present, err := s.HasSecret(ctx, "agent-profile:ghost"); err != nil || present {
		t.Fatalf("failed rename created a target row (present=%v, err=%v)", present, err)
	}
}

func TestRenameSecretWithoutKeyIsDisabled(t *testing.T) {
	s, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.RenameSecret(context.Background(), "old", "new"); !errors.Is(err, ErrSecretStoreDisabled) {
		t.Fatalf("rename without key path returned %v, want ErrSecretStoreDisabled", err)
	}
}
