package sqlitestore

import (
	"cmp"
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
	legacy := strings.TrimSpace(input.MachineFingerprint)
	if legacy == "" {
		return store.DeviceIdentity{}, errors.New("machine fingerprint is required")
	}
	// A worker that reports its own fingerprint is keyed by it; one before
	// it keeps the machine's.
	key := cmp.Or(strings.TrimSpace(input.WorkerFingerprint), legacy)
	account := strings.TrimSpace(input.Identity.OSAccountFingerprint)
	host := strings.TrimSpace(input.Identity.HostFingerprint)
	var identity store.DeviceIdentity
	var shared *store.DeviceAccountSharedError
	err := s.withTx(ctx, func(tx *Store) error {
		var userID, expiresAt, consent string
		var usedAt sql.NullString
		err := tx.conn().QueryRowContext(ctx,
			`SELECT user_id, expires_at, used_at, consent FROM device_pairing_tokens WHERE token_hash = ?`,
			input.TokenHash).Scan(&userID, &expiresAt, &usedAt, &consent)
		if errors.Is(err, sql.ErrNoRows) {
			return store.ErrDevicePairingInvalid
		}
		if err != nil {
			return fmt.Errorf("read device pairing token: %w", err)
		}
		if usedAt.Valid || !input.Now.Before(parseStoredTime(expiresAt)) {
			return store.ErrDevicePairingInvalid
		}
		if consent == pairingConsentCancelled {
			return store.ErrDevicePairingCancelled
		}
		owner, err := tx.GetUser(ctx, userID)
		if err != nil {
			return err
		}
		if !owner.Active() {
			return store.ErrDevicePairingInvalid
		}

		match, err := tx.pairedDevice(ctx, userID, key, legacy, account, input.RequestedDeviceID)
		if err != nil {
			return err
		}
		deviceID := match.deviceID
		others, err := tx.otherAccountUsers(ctx, account, userID, deviceID)
		if err != nil {
			return err
		}
		if len(others) > 0 && !input.AcceptSharedAccount && consent != pairingConsentAccepted {
			shared = &store.DeviceAccountSharedError{SharedWith: ownerNames(others)}
			return shared
		}
		now := formatTime(input.Now)
		if match.rowDeviceID != "" {
			_, err = tx.conn().ExecContext(ctx, `UPDATE device_identities
				SET device_id = ?, machine_fingerprint = ?, credential_hash = ?, paired_at = ?, revoked_at = NULL,
					os_account_fingerprint = CASE WHEN ? = '' THEN os_account_fingerprint ELSE ? END,
					host_fingerprint = CASE WHEN ? = '' THEN host_fingerprint ELSE ? END
				WHERE device_id = ?`,
				deviceID, key, input.CredentialHash, now, account, account, host, host, match.rowDeviceID)
		} else {
			_, err = tx.conn().ExecContext(ctx, `INSERT INTO device_identities
				(device_id, owner_user_id, machine_fingerprint, credential_hash, paired_at, os_account_fingerprint, host_fingerprint)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
				deviceID, userID, key, input.CredentialHash, now, account, host)
		}
		if err != nil {
			return fmt.Errorf("save device identity: %w", err)
		}
		for _, other := range others {
			// The later device records the choice; the one there first owes
			// its owner a notice.
			if _, err := tx.conn().ExecContext(ctx, `INSERT OR IGNORE INTO device_account_shares
				(device_id, shared_device_id, accepted_by_user_id, accepted_at) VALUES (?, ?, ?, ?)`,
				deviceID, other.deviceID, userID, now); err != nil {
				return fmt.Errorf("record shared system account: %w", err)
			}
		}
		if _, err := tx.conn().ExecContext(ctx,
			`UPDATE device_pairing_tokens SET used_at = ?, used_by_device_id = ? WHERE token_hash = ?`,
			now, deviceID, input.TokenHash); err != nil {
			return fmt.Errorf("consume device pairing token: %w", err)
		}
		identity = store.DeviceIdentity{DeviceID: deviceID, OwnerUserID: userID, MachineFingerprint: key, PairedAt: input.Now}
		return nil
	})
	if shared != nil {
		// Nothing was paired; the token now says what it waits for, so the
		// web can ask the person too.
		if err := s.notePairingNeedsConsent(ctx, input.TokenHash, shared.SharedWith); err != nil {
			return store.DeviceIdentity{}, err
		}
	}
	return identity, err
}

// pairingMatch is the device a pairing becomes: deviceID, and the identity
// row it takes over (rowDeviceID), if any.
type pairingMatch struct {
	deviceID    string
	rowDeviceID string
}

// pairedDevice picks the device a pairing becomes. The same account on the
// same worker keeps its device unless that device was removed; a device
// paired before workers reported their own fingerprint (keyed by the
// machine's) is kept only for the same system account, or when the worker
// still holds its id. Otherwise the worker's local id is kept when nobody
// else holds it.
func (s *Store) pairedDevice(ctx context.Context, userID, key, legacy, account, requested string) (pairingMatch, error) {
	requested = strings.TrimSpace(requested)
	var match pairingMatch
	err := s.conn().QueryRowContext(ctx,
		`SELECT device_id FROM device_identities WHERE owner_user_id = ? AND machine_fingerprint = ?`,
		userID, key).Scan(&match.rowDeviceID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return match, fmt.Errorf("find paired device: %w", err)
	}
	if errors.Is(err, sql.ErrNoRows) && key != legacy {
		var current, recorded string
		err = s.conn().QueryRowContext(ctx,
			`SELECT device_id, os_account_fingerprint FROM device_identities WHERE owner_user_id = ? AND machine_fingerprint = ?`,
			userID, legacy).Scan(&current, &recorded)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return match, fmt.Errorf("find paired device: %w", err)
		}
		if err == nil && ((account != "" && recorded == account) || (recorded == "" && current == requested)) {
			match.rowDeviceID = current
		}
	}
	if match.rowDeviceID != "" {
		removed, err := s.DeviceRemoved(ctx, match.rowDeviceID)
		if err != nil {
			return match, err
		}
		if !removed {
			match.deviceID = match.rowDeviceID
			return match, nil
		}
	}
	if requested != "" && requested != match.rowDeviceID {
		free, err := s.deviceIDFree(ctx, requested)
		if err != nil {
			return match, err
		}
		if free {
			match.deviceID = requested
			return match, nil
		}
	}
	match.deviceID = "dev_" + uuid.NewString()
	return match, nil
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
	err := s.reader().QueryRowContext(ctx, `SELECT d.device_id, d.owner_user_id, d.machine_fingerprint, d.paired_at,
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
	err := s.reader().QueryRowContext(ctx,
		`SELECT owner_user_id FROM device_identities WHERE device_id = ?`, deviceID).Scan(&owner)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("find device owner: %w", err)
	}
	return owner, nil
}
