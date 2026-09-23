package secretstore

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureKEKGeneratesOwnerOnlyFileAndLoadsStably(t *testing.T) {
	path := filepath.Join(t.TempDir(), "foundry-secret.key")
	first, err := EnsureKEK(path)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("key file permission = %o, want 0600", perm)
	}
	second, err := EnsureKEK(path)
	if err != nil {
		t.Fatal(err)
	}
	if first.Fingerprint != second.Fingerprint {
		t.Fatalf("EnsureKEK regenerated an existing key: %s != %s", first.Fingerprint, second.Fingerprint)
	}
	if !strings.Contains(SerializeKEK(first), KeyFormatV1) {
		t.Fatal("serialized key missing format line")
	}
}

func TestParseKeyFileRejectsMalformedInput(t *testing.T) {
	cases := map[string]string{
		"empty":         "",
		"wrong prefix":  "NOT-A-KEY abcdefghijklmnopqrstuvwxyz\n",
		"bad base64":    KeyFormatV1 + " !!!not base64!!!\n",
		"wrong length":  KeyFormatV1 + " YWJj\n", /* "abc", 3 bytes */
		"comments only": "# just a comment\n",
	}
	for name, data := range cases {
		if _, err := parseKeyFile([]byte(data)); err == nil {
			t.Fatalf("%s: parse unexpectedly succeeded", name)
		}
	}
	good, err := GenerateKEK()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parseKeyFile([]byte(SerializeKEK(good))); err != nil {
		t.Fatalf("roundtrip parse failed: %v", err)
	}
}

func TestWriteKEKRefusesExistingFileAndForceKeepsBackup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "foundry-secret.key")
	original, err := GenerateKEK()
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteKEK(path, original, false); err != nil {
		t.Fatal(err)
	}
	if err := WriteKEK(path, original, false); err == nil {
		t.Fatal("write without force unexpectedly replaced an existing key")
	}
	replacement, err := GenerateKEK()
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteKEK(path, replacement, true); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadKEK(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Fingerprint != replacement.Fingerprint {
		t.Fatal("forced write did not replace the live key")
	}
	backup, err := LoadKEK(path + ".old")
	if err != nil {
		t.Fatalf("forced write lost the old key: %v", err)
	}
	if backup.Fingerprint != original.Fingerprint {
		t.Fatal("backup does not hold the previous key")
	}
}

func TestPromotePendingKEKCompletesInterruptedRotation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "foundry-secret.key")
	old, err := GenerateKEK()
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteKEK(path, old, false); err != nil {
		t.Fatal(err)
	}
	next, err := GenerateKEK()
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteKEK(path+".new", next, true); err != nil {
		t.Fatal(err)
	}
	promoted, err := PromotePendingKEK(path)
	if err != nil {
		t.Fatal(err)
	}
	if !promoted {
		t.Fatal("promotion reported no-op with a pending key present")
	}
	loaded, err := LoadKEK(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Fingerprint != next.Fingerprint {
		t.Fatal("promotion left the old key live")
	}
	if _, err := os.Stat(path + ".new"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("pending key survived promotion")
	}
	again, err := PromotePendingKEK(path)
	if err != nil || again {
		t.Fatalf("second promotion reported %v/%v, want false/nil", again, err)
	}
}
