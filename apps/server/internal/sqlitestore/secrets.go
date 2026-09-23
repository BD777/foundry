package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/secretstore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// ErrSecretKeyMismatch means the key file on disk does not pair with this
// database. It names the expected fingerprint so an operator can tell a lost
// key from an interrupted rotation at a glance.
var ErrSecretKeyMismatch = errors.New("secret store key mismatch")

// ErrSecretStoreDisabled means the store was opened without SecretKeyPath, so
// secret operations are unavailable rather than silently unencrypted.
var ErrSecretStoreDisabled = errors.New("secret store is not configured for this database")

// setupSecretStore pairs the database with the KEK file. With no prior
// metadata it adopts (or creates) the key file and seals a fresh canary. With
// prior metadata it fails closed unless the live key — or a pending rotation
// candidate left by an interrupted `keys rotate` — verifies the stored canary.
// The resolved KEK stays in memory for the lifetime of the Store, so request
// paths never touch the key file again.
func (s *Store) setupSecretStore(ctx context.Context, keyPath string) error {
	meta, metaErr := s.secretStoreMeta(ctx)
	if metaErr != nil && !errors.Is(metaErr, store.ErrNotFound) {
		return metaErr
	}
	if metaErr == nil {
		return s.adoptExistingKey(keyPath, meta)
	}

	// Fresh database: adopt the live key, or generate one when absent.
	kek, err := secretstore.EnsureKEK(keyPath)
	if err != nil {
		return fmt.Errorf("prepare secret key %s: %w", keyPath, err)
	}
	if err := s.initSecretStoreMeta(ctx, kek); err != nil {
		return err
	}
	s.kek = kek
	return nil
}

func (s *Store) adoptExistingKey(keyPath string, meta secretStoreMeta) error {
	if kek, err := secretstore.LoadKEK(keyPath); err == nil {
		if secretstore.VerifyCanary(kek, meta.canary()) {
			s.kek = kek
			return nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("load secret key %s: %w", keyPath, err)
	}
	// Missing or mismatched live key: an interrupted `keys rotate` may have
	// staged the new key beside it. Promoting it is always safe — promotion
	// only happens when the candidate verifies the stored canary.
	if pending, err := secretstore.LoadKEK(keyPath + ".new"); err == nil &&
		secretstore.VerifyCanary(pending, meta.canary()) {
		if _, err := secretstore.PromotePendingKEK(keyPath); err != nil {
			return err
		}
		s.kek = pending
		return nil
	}
	return fmt.Errorf("%w: database expects key fingerprint sha256:%s; restore the matching key file at %s from backup, or run `foundry-server keys reinitialize --accept-data-loss` to discard stored secrets",
		ErrSecretKeyMismatch, meta.KEKFingerprint, keyPath)
}

// SecretKEKFingerprint reports the active key's fingerprint, or "" when the
// secret store is disabled. `keys fingerprint` prints the file's value;
// startup logs print this one; their equality is the health check.
func (s *Store) SecretKEKFingerprint() string {
	return s.kek.Fingerprint
}

// PutSecret seals plaintext under the in-memory KEK and upserts it under id.
// The additional data is stored with the row and becomes part of its crypto
// identity: relocating or relabeling a row makes it fail to unseal.
func (s *Store) PutSecret(ctx context.Context, id string, plaintext []byte, additionalData string) error {
	if s.kek.Fingerprint == "" {
		return ErrSecretStoreDisabled
	}
	record, err := secretstore.Seal(s.kek, plaintext, additionalData)
	if err != nil {
		return fmt.Errorf("seal secret %s: %w", id, err)
	}
	now := formatTime(time.Now())
	_, err = s.conn().ExecContext(ctx, `
		INSERT INTO secret_records (id, aad, ciphertext, wrapped_dek, dek_nonce, ct_nonce, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			aad = excluded.aad,
			ciphertext = excluded.ciphertext,
			wrapped_dek = excluded.wrapped_dek,
			dek_nonce = excluded.dek_nonce,
			ct_nonce = excluded.ct_nonce,
			updated_at = excluded.updated_at`,
		id, additionalData, record.Ciphertext, record.WrappedDEK, record.DEKNonce, record.CTNonce, now, now)
	if err != nil {
		return fmt.Errorf("store secret %s: %w", id, err)
	}
	return nil
}

// GetSecret unseals the record stored under id using the row's own identity.
// A wrong key or a tampered row fails closed; only a genuinely absent row
// surfaces store.ErrNotFound.
func (s *Store) GetSecret(ctx context.Context, id string) ([]byte, error) {
	if s.kek.Fingerprint == "" {
		return nil, ErrSecretStoreDisabled
	}
	var record secretstore.Record
	var aad string
	err := s.conn().QueryRowContext(ctx,
		`SELECT ciphertext, wrapped_dek, dek_nonce, ct_nonce, aad FROM secret_records WHERE id = ?`, id,
	).Scan(&record.Ciphertext, &record.WrappedDEK, &record.DEKNonce, &record.CTNonce, &aad)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, store.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("load secret %s: %w", id, err)
	}
	plaintext, err := secretstore.Open(s.kek, record, aad)
	if err != nil {
		return nil, fmt.Errorf("unseal secret %s: %w", id, err)
	}
	return plaintext, nil
}

// DeleteSecret removes the record under id.
func (s *Store) DeleteSecret(ctx context.Context, id string) error {
	_, err := s.conn().ExecContext(ctx, `DELETE FROM secret_records WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete secret %s: %w", id, err)
	}
	return nil
}

// HasSecret reports whether a record exists under id without unsealing it.
func (s *Store) HasSecret(ctx context.Context, id string) (bool, error) {
	var one int
	err := s.conn().QueryRowContext(ctx, `SELECT 1 FROM secret_records WHERE id = ?`, id).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("check secret %s: %w", id, err)
	}
	return true, nil
}

// RenameSecret moves a record to a new id. A sealed record's identity includes
// its additional data, so the row cannot simply be re-keyed: it is opened under
// the old id, resealed under the new one with newID as its additional data, and
// the old row dropped — all inside one transaction, so a crash can never leave
// the credential under both ids or neither. Promotion of a device-scoped
// profile to a server profile rides on this and needs no key from the user.
func (s *Store) RenameSecret(ctx context.Context, oldID string, newID string) error {
	if s.kek.Fingerprint == "" {
		return ErrSecretStoreDisabled
	}
	if oldID == newID {
		return nil
	}
	return s.withTx(ctx, func(tx *Store) error {
		plaintext, err := tx.GetSecret(ctx, oldID)
		if err != nil {
			return err
		}
		if err := tx.PutSecret(ctx, newID, plaintext, newID); err != nil {
			return err
		}
		return tx.DeleteSecret(ctx, oldID)
	})
}

// RotateSecrets re-wraps every stored record and the canary under newKEK in
// one transaction, then adopts newKEK in memory. Ciphertext is untouched, so
// the old key becomes useless the moment this commits; callers must publish
// the new key file right after (the .new/.old handshake in `keys rotate`).
func (s *Store) RotateSecrets(ctx context.Context, newKEK secretstore.KEK) (int, error) {
	if s.kek.Fingerprint == "" {
		return 0, ErrSecretStoreDisabled
	}
	rotated := 0
	err := s.withTx(ctx, func(tx *Store) error {
		meta, err := tx.secretStoreMeta(ctx)
		if err != nil {
			return err
		}
		if !secretstore.VerifyCanary(tx.kek, meta.canary()) {
			return fmt.Errorf("canary verification failed before rotation")
		}
		type stagedRow struct {
			id        string
			record    secretstore.Record
			aad       string
			rewrapped secretstore.Record
		}
		rows, err := tx.conn().QueryContext(ctx,
			`SELECT id, ciphertext, wrapped_dek, dek_nonce, ct_nonce, aad FROM secret_records`)
		if err != nil {
			return fmt.Errorf("load secrets for rotation: %w", err)
		}
		var staged []stagedRow
		for rows.Next() {
			var row stagedRow
			if err := rows.Scan(&row.id, &row.record.Ciphertext, &row.record.WrappedDEK,
				&row.record.DEKNonce, &row.record.CTNonce, &row.aad); err != nil {
				rows.Close()
				return fmt.Errorf("scan secret for rotation: %w", err)
			}
			rewrapped, err := secretstore.Rewrap(tx.kek, newKEK, row.record, row.aad)
			if err != nil {
				rows.Close()
				return fmt.Errorf("rewrap secret %s: %w", row.id, err)
			}
			row.rewrapped = rewrapped
			staged = append(staged, row)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return fmt.Errorf("iterate secrets for rotation: %w", err)
		}
		rows.Close()

		now := formatTime(time.Now())
		for _, row := range staged {
			if _, err := tx.conn().ExecContext(ctx, `
				UPDATE secret_records
				SET wrapped_dek = ?, dek_nonce = ?, updated_at = ?
				WHERE id = ?`,
				row.rewrapped.WrappedDEK, row.rewrapped.DEKNonce, now, row.id); err != nil {
				return fmt.Errorf("persist rewrapped secret %s: %w", row.id, err)
			}
		}
		canary, err := secretstore.SealCanary(newKEK)
		if err != nil {
			return fmt.Errorf("seal rotated canary: %w", err)
		}
		if _, err := tx.conn().ExecContext(ctx, `
			UPDATE secret_store_meta
			SET canary_ciphertext = ?, canary_wrapped_dek = ?, canary_dek_nonce = ?, canary_ct_nonce = ?,
				kek_fingerprint = ?, updated_at = ?
			WHERE id = 1`,
			canary.Ciphertext, canary.WrappedDEK, canary.DEKNonce, canary.CTNonce,
			newKEK.Fingerprint, now); err != nil {
			return fmt.Errorf("persist rotated canary: %w", err)
		}
		rotated = len(staged)
		return nil
	})
	if err != nil {
		return 0, err
	}
	s.kek = newKEK
	return rotated, nil
}

// ResetSecretStore discards all stored secrets and re-pairs the database with
// newKEK. It is the documented recovery path for a lost key file and sits
// behind the CLI's explicit --accept-data-loss flag.
func (s *Store) ResetSecretStore(ctx context.Context, newKEK secretstore.KEK) error {
	err := s.withTx(ctx, func(tx *Store) error {
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM secret_records`); err != nil {
			return fmt.Errorf("discard stored secrets: %w", err)
		}
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM secret_store_meta`); err != nil {
			return fmt.Errorf("discard secret store metadata: %w", err)
		}
		return nil
	})
	if err != nil {
		return err
	}
	if err := s.initSecretStoreMeta(ctx, newKEK); err != nil {
		return err
	}
	s.kek = newKEK
	return nil
}

type secretStoreMeta struct {
	CanaryCiphertext []byte
	CanaryWrappedDEK []byte
	CanaryDEKNonce   []byte
	CanaryCTNonce    []byte
	KEKFingerprint   string
}

func (m secretStoreMeta) canary() secretstore.Record {
	return secretstore.Record{
		Ciphertext: m.CanaryCiphertext,
		WrappedDEK: m.CanaryWrappedDEK,
		DEKNonce:   m.CanaryDEKNonce,
		CTNonce:    m.CanaryCTNonce,
	}
}

func (s *Store) secretStoreMeta(ctx context.Context) (secretStoreMeta, error) {
	var meta secretStoreMeta
	err := s.conn().QueryRowContext(ctx, `
		SELECT canary_ciphertext, canary_wrapped_dek, canary_dek_nonce, canary_ct_nonce, kek_fingerprint
		FROM secret_store_meta WHERE id = 1`,
	).Scan(&meta.CanaryCiphertext, &meta.CanaryWrappedDEK, &meta.CanaryDEKNonce, &meta.CanaryCTNonce, &meta.KEKFingerprint)
	if errors.Is(err, sql.ErrNoRows) {
		return secretStoreMeta{}, store.ErrNotFound
	}
	if err != nil {
		return secretStoreMeta{}, fmt.Errorf("load secret store metadata: %w", err)
	}
	return meta, nil
}

func (s *Store) initSecretStoreMeta(ctx context.Context, kek secretstore.KEK) error {
	canary, err := secretstore.SealCanary(kek)
	if err != nil {
		return fmt.Errorf("seal canary: %w", err)
	}
	now := formatTime(time.Now())
	_, err = s.conn().ExecContext(ctx, `
		INSERT INTO secret_store_meta
			(id, canary_ciphertext, canary_wrapped_dek, canary_dek_nonce, canary_ct_nonce, kek_fingerprint, initialized_at, updated_at)
		VALUES (1, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO NOTHING`,
		canary.Ciphertext, canary.WrappedDEK, canary.DEKNonce, canary.CTNonce, kek.Fingerprint, now, now)
	if err != nil {
		return fmt.Errorf("initialize secret store metadata: %w", err)
	}
	return nil
}
