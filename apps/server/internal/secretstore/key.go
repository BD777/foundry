// Package secretstore owns the server-side credential store cryptography:
// a key-encryption-key (KEK) file plus AES-256-GCM envelope sealing where each
// secret gets an independent data key (DEK) wrapped by the KEK. The KEK never
// encrypts user data directly, so rotating the KEK or changing where it comes
// from (file, passphrase, device shards) only re-wraps 32-byte DEKs and never
// touches ciphertext.
package secretstore

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// KeyFormatV1 is the first line prefix of a key file.
	KeyFormatV1 = "FOUNDRY-SECRET-KEY-1"
	// KeyBytes is the KEK length; AES-256 requires 32 bytes.
	KeyBytes = 32
	// keyFilePerm matches the private worker JSON convention: owner-only.
	keyFilePerm = 0o600
)

// KEK is a loaded key-encryption key. It lives in process memory for the
// lifetime of the store; nothing here re-reads the key file per operation.
type KEK struct {
	Key         [KeyBytes]byte
	CreatedAt   time.Time
	Fingerprint string
}

// GenerateKEK returns a fresh cryptographically random KEK.
func GenerateKEK() (KEK, error) {
	var kek KEK
	if _, err := rand.Read(kek.Key[:]); err != nil {
		return KEK{}, fmt.Errorf("generate key material: %w", err)
	}
	kek.CreatedAt = time.Now().UTC()
	kek.Fingerprint = fingerprint(kek.Key)
	return kek, nil
}

// LoadKEK reads and parses an existing key file. A missing file returns an
// error wrapping os.ErrNotExist so callers can distinguish it from corruption.
func LoadKEK(path string) (KEK, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return KEK{}, err
	}
	return parseKeyFile(data)
}

// EnsureKEK returns the key file's KEK, generating the file when absent. The
// write is atomic (temp file + rename) with owner-only permissions, so a
// crash can never leave a partial or world-readable key behind.
func EnsureKEK(path string) (KEK, error) {
	if kek, err := LoadKEK(path); err == nil {
		return kek, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return KEK{}, err
	}
	kek, err := GenerateKEK()
	if err != nil {
		return KEK{}, err
	}
	if err := writeKeyFile(path, kek); err != nil {
		return KEK{}, err
	}
	return kek, nil
}

// PromotePendingKEK completes an interrupted rotation: the staged candidate
// at path+".new" atomically replaces the live key. It reports whether a
// promotion happened.
func PromotePendingKEK(path string) (bool, error) {
	pending := path + ".new"
	if _, err := os.Stat(pending); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	if err := os.Rename(pending, path); err != nil {
		return false, fmt.Errorf("promote pending key: %w", err)
	}
	return true, nil
}

// WriteKEK atomically writes kek to path, refusing to touch an existing file
// unless force moves it aside first (force keeps the old key at path+".old").
func WriteKEK(path string, kek KEK, force bool) error {
	if !force {
		if _, err := os.Stat(path); err == nil {
			return fmt.Errorf("%s already exists; pass --force to replace it", path)
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if force {
		if _, err := os.Stat(path); err == nil {
			if err := os.Rename(path, path+".old"); err != nil {
				return fmt.Errorf("back up existing key: %w", err)
			}
		}
	}
	return writeKeyFile(path, kek)
}

func writeKeyFile(path string, kek KEK) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create key directory: %w", err)
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".foundry-secret-key-*")
	if err != nil {
		return fmt.Errorf("stage key file: %w", err)
	}
	name := temp.Name()
	if _, err := temp.WriteString(SerializeKEK(kek)); err != nil {
		temp.Close()
		os.Remove(name)
		return fmt.Errorf("stage key file: %w", err)
	}
	if err := temp.Chmod(keyFilePerm); err != nil {
		temp.Close()
		os.Remove(name)
		return fmt.Errorf("harden staged key file: %w", err)
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		os.Remove(name)
		return fmt.Errorf("sync staged key file: %w", err)
	}
	if err := temp.Close(); err != nil {
		os.Remove(name)
		return fmt.Errorf("stage key file: %w", err)
	}
	if err := os.Rename(name, path); err != nil {
		os.Remove(name)
		return fmt.Errorf("publish key file: %w", err)
	}
	return nil
}

// SerializeKEK renders the key as a single payload line plus comment headers,
// mirroring the one-identity-per-file shape of age and SSH key files.
func SerializeKEK(kek KEK) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s %s\n", KeyFormatV1, base64.StdEncoding.EncodeToString(kek.Key[:]))
	fmt.Fprintf(&b, "# created %s\n", kek.CreatedAt.Format(time.RFC3339))
	fmt.Fprintf(&b, "# fingerprint sha256:%s\n", kek.Fingerprint)
	return b.String()
}

func parseKeyFile(data []byte) (KEK, error) {
	var kek KEK
	found := false
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if created, ok := strings.CutPrefix(line, "# created "); ok {
			if parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(created)); err == nil {
				kek.CreatedAt = parsed
			}
			continue
		}
		if strings.HasPrefix(line, "#") {
			continue
		}
		prefix := KeyFormatV1 + " "
		if !strings.HasPrefix(line, prefix) {
			return KEK{}, fmt.Errorf("unrecognized key file format")
		}
		raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(line, prefix))
		if err != nil {
			return KEK{}, fmt.Errorf("decode key material: %w", err)
		}
		if len(raw) != KeyBytes {
			return KEK{}, fmt.Errorf("key file holds %d bytes, want %d", len(raw), KeyBytes)
		}
		copy(kek.Key[:], raw)
		found = true
	}
	if !found {
		return KEK{}, fmt.Errorf("key file has no %s payload line", KeyFormatV1)
	}
	kek.Fingerprint = fingerprint(kek.Key)
	return kek, nil
}

func fingerprint(key [KeyBytes]byte) string {
	sum := sha256.Sum256(key[:])
	return fmt.Sprintf("%x", sum[:8])
}
