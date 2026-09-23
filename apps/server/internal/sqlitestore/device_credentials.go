package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

var _ store.DeviceCredentialStore = (*Store)(nil)

func (s *Store) setupDeviceCredentials(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS device_pairing_tokens (
			token_hash TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			used_at TEXT,
			used_by_device_id TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS device_identities (
			device_id TEXT PRIMARY KEY,
			owner_user_id TEXT NOT NULL REFERENCES users(id),
			machine_fingerprint TEXT NOT NULL,
			credential_hash TEXT NOT NULL UNIQUE,
			paired_at TEXT NOT NULL,
			revoked_at TEXT,
			UNIQUE (owner_user_id, machine_fingerprint)
		)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite device credentials: %w", err)
		}
	}
	return nil
}

func (s *Store) CreateDevicePairingToken(ctx context.Context, tokenHash, userID string, expiresAt time.Time) error {
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO device_pairing_tokens
		(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
		tokenHash, userID, formatTime(time.Now().UTC()), formatTime(expiresAt)); err != nil {
		return fmt.Errorf("create device pairing token: %w", err)
	}
	return nil
}

func (s *Store) PairDevice(ctx context.Context, input store.PairDeviceInput) (store.DeviceIdentity, error) {
	fingerprint := strings.TrimSpace(input.MachineFingerprint)
	if fingerprint == "" {
		return store.DeviceIdentity{}, errors.New("machine fingerprint is required")
	}
	var identity store.DeviceIdentity
	err := s.withTx(ctx, func(tx *Store) error {
		var userID, expiresAt string
		var usedAt sql.NullString
		err := tx.conn().QueryRowContext(ctx,
			`SELECT user_id, expires_at, used_at FROM device_pairing_tokens WHERE token_hash = ?`,
			input.TokenHash).Scan(&userID, &expiresAt, &usedAt)
		if errors.Is(err, sql.ErrNoRows) {
			return store.ErrDevicePairingInvalid
		}
		if err != nil {
			return fmt.Errorf("read device pairing token: %w", err)
		}
		if usedAt.Valid || !input.Now.Before(parseStoredTime(expiresAt)) {
			return store.ErrDevicePairingInvalid
		}
		owner, err := tx.GetUser(ctx, userID)
		if err != nil {
			return err
		}
		if !owner.Active() {
			return store.ErrDevicePairingInvalid
		}

		deviceID, existing, err := tx.pairedDeviceID(ctx, userID, fingerprint, input.RequestedDeviceID)
		if err != nil {
			return err
		}
		now := formatTime(input.Now)
		if existing {
			_, err = tx.conn().ExecContext(ctx, `UPDATE device_identities
				SET device_id = ?, credential_hash = ?, paired_at = ?, revoked_at = NULL
				WHERE owner_user_id = ? AND machine_fingerprint = ?`,
				deviceID, input.CredentialHash, now, userID, fingerprint)
		} else {
			_, err = tx.conn().ExecContext(ctx, `INSERT INTO device_identities
				(device_id, owner_user_id, machine_fingerprint, credential_hash, paired_at)
				VALUES (?, ?, ?, ?, ?)`,
				deviceID, userID, fingerprint, input.CredentialHash, now)
		}
		if err != nil {
			return fmt.Errorf("save device identity: %w", err)
		}
		if _, err := tx.conn().ExecContext(ctx,
			`UPDATE device_pairing_tokens SET used_at = ?, used_by_device_id = ? WHERE token_hash = ?`,
			now, deviceID, input.TokenHash); err != nil {
			return fmt.Errorf("consume device pairing token: %w", err)
		}
		identity = store.DeviceIdentity{DeviceID: deviceID, OwnerUserID: userID, MachineFingerprint: fingerprint, PairedAt: input.Now}
		return nil
	})
	return identity, err
}

// pairedDeviceID picks the device id for a pairing. The same account on the
// same machine keeps its device unless that device was removed; otherwise the
// worker's local id is kept when nobody else holds it.
func (s *Store) pairedDeviceID(ctx context.Context, userID, fingerprint, requested string) (string, bool, error) {
	var current string
	err := s.conn().QueryRowContext(ctx,
		`SELECT device_id FROM device_identities WHERE owner_user_id = ? AND machine_fingerprint = ?`,
		userID, fingerprint).Scan(&current)
	existing := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", false, fmt.Errorf("find paired device: %w", err)
	}
	if existing {
		removed, err := s.DeviceRemoved(ctx, current)
		if err != nil {
			return "", false, err
		}
		if !removed {
			return current, true, nil
		}
	}
	requested = strings.TrimSpace(requested)
	if requested != "" && requested != current {
		free, err := s.deviceIDFree(ctx, requested)
		if err != nil {
			return "", false, err
		}
		if free {
			return requested, existing, nil
		}
	}
	return "dev_" + uuid.NewString(), existing, nil
}

func (s *Store) deviceIDFree(ctx context.Context, deviceID string) (bool, error) {
	var claimed int
	if err := s.conn().QueryRowContext(ctx,
		`SELECT COUNT(*) FROM device_identities WHERE device_id = ?`, deviceID).Scan(&claimed); err != nil {
		return false, fmt.Errorf("check device id: %w", err)
	}
	if claimed > 0 {
		return false, nil
	}
	removed, err := s.DeviceRemoved(ctx, deviceID)
	return !removed, err
}

func (s *Store) ResolveDeviceCredential(ctx context.Context, credentialHash string) (store.DeviceIdentity, error) {
	var identity store.DeviceIdentity
	var pairedAt string
	var revokedAt sql.NullString
	var ownerDisabled sql.NullString
	err := s.conn().QueryRowContext(ctx, `SELECT d.device_id, d.owner_user_id, d.machine_fingerprint, d.paired_at,
			d.revoked_at, u.disabled_at
		FROM device_identities AS d JOIN users AS u ON u.id = d.owner_user_id
		WHERE d.credential_hash = ?`, credentialHash).
		Scan(&identity.DeviceID, &identity.OwnerUserID, &identity.MachineFingerprint, &pairedAt, &revokedAt, &ownerDisabled)
	if errors.Is(err, sql.ErrNoRows) {
		return store.DeviceIdentity{}, store.ErrDeviceCredentialInvalid
	}
	if err != nil {
		return store.DeviceIdentity{}, fmt.Errorf("resolve device credential: %w", err)
	}
	if revokedAt.Valid || ownerDisabled.Valid {
		return store.DeviceIdentity{}, store.ErrDeviceCredentialInvalid
	}
	identity.PairedAt = parseStoredTime(pairedAt)
	return identity, nil
}

func (s *Store) RevokeDeviceCredential(ctx context.Context, deviceID string) error {
	if _, err := s.conn().ExecContext(ctx,
		`UPDATE device_identities SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL`,
		formatTime(time.Now().UTC()), deviceID); err != nil {
		return fmt.Errorf("revoke device credential: %w", err)
	}
	return nil
}

func (s *Store) DeviceOwner(ctx context.Context, deviceID string) (string, error) {
	var owner string
	err := s.conn().QueryRowContext(ctx,
		`SELECT owner_user_id FROM device_identities WHERE device_id = ?`, deviceID).Scan(&owner)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("find device owner: %w", err)
	}
	return owner, nil
}
