package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

var _ store.DeviceSharingStore = (*Store)(nil)

// A pairing token's consent: "" until a worker tried to pair under a system
// account other people's devices use; then "needed" until the person chose.
const (
	pairingConsentNeeded    = "needed"
	pairingConsentAccepted  = "accepted"
	pairingConsentCancelled = "cancelled"
)

// setupDeviceAccountSharing adds the index of what workers report about
// the system account they run under (device_identities) and the record of
// who chose to share an account (device_account_shares: device_id is the device
// paired later, shared_device_id the one that was there first).
func (s *Store) setupDeviceAccountSharing(ctx context.Context) error {
	for _, statement := range []string{
		`CREATE INDEX IF NOT EXISTS device_identities_os_account ON device_identities(os_account_fingerprint)`,
		`CREATE TABLE IF NOT EXISTS device_account_shares (
			device_id TEXT NOT NULL,
			shared_device_id TEXT NOT NULL,
			accepted_by_user_id TEXT NOT NULL,
			accepted_at TEXT NOT NULL,
			notice_seen_at TEXT,
			PRIMARY KEY (device_id, shared_device_id)
		)`,
	} {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite device account sharing: %w", err)
		}
	}
	return nil
}

// accountUser is another person's live device under a system account.
type accountUser struct {
	deviceID  string
	ownerName string
}

// otherAccountUsers are the live devices of people other than userID under
// the system account, leaving out deviceID and the devices someone already
// chose to share it with.
func (s *Store) otherAccountUsers(ctx context.Context, account, userID, deviceID string) ([]accountUser, error) {
	if account == "" {
		return nil, nil
	}
	rows, err := s.conn().QueryContext(ctx, `SELECT d.device_id, COALESCE(NULLIF(u.display_name, ''), u.username)
		FROM device_identities AS d JOIN users AS u ON u.id = d.owner_user_id
		WHERE d.os_account_fingerprint = ? AND d.owner_user_id != ? AND d.device_id != ?
			AND d.revoked_at IS NULL
			AND NOT EXISTS (SELECT 1 FROM removed_devices AS r WHERE r.device_id = d.device_id)
			AND NOT EXISTS (SELECT 1 FROM device_account_shares AS s
				WHERE (s.device_id = ? AND s.shared_device_id = d.device_id)
					OR (s.device_id = d.device_id AND s.shared_device_id = ?))
		ORDER BY d.paired_at, d.device_id`, account, userID, deviceID, deviceID, deviceID)
	if err != nil {
		return nil, fmt.Errorf("find system account users: %w", err)
	}
	defer rows.Close()
	var users []accountUser
	for rows.Next() {
		var user accountUser
		if err := rows.Scan(&user.deviceID, &user.ownerName); err != nil {
			return nil, fmt.Errorf("scan system account user: %w", err)
		}
		users = append(users, user)
	}
	return users, rows.Err()
}

// ownerNames are the users' names, each once, in order.
func ownerNames(users []accountUser) []string {
	names := []string{}
	for _, user := range users {
		if !slices.Contains(names, user.ownerName) {
			names = append(names, user.ownerName)
		}
	}
	return names
}

// notePairingNeedsConsent marks the token as waiting for the person's
// choice, unless they already made one.
func (s *Store) notePairingNeedsConsent(ctx context.Context, tokenHash string, sharedWith []string) error {
	names, err := json.Marshal(sharedWith)
	if err != nil {
		return err
	}
	if _, err := s.conn().ExecContext(ctx, `UPDATE device_pairing_tokens SET consent = ?, shared_with_json = ?
		WHERE token_hash = ? AND consent = ''`, pairingConsentNeeded, string(names), tokenHash); err != nil {
		return fmt.Errorf("note pairing consent: %w", err)
	}
	return nil
}

func (s *Store) RecordDeviceAccountIdentity(ctx context.Context, deviceID string, identity store.DeviceAccountIdentity) (bool, error) {
	account := strings.TrimSpace(identity.OSAccountFingerprint)
	host := strings.TrimSpace(identity.HostFingerprint)
	if account == "" && host == "" {
		return false, nil
	}
	result, err := s.conn().ExecContext(ctx, `UPDATE device_identities
		SET os_account_fingerprint = CASE WHEN ? = '' THEN os_account_fingerprint ELSE ? END,
			host_fingerprint = CASE WHEN ? = '' THEN host_fingerprint ELSE ? END
		WHERE device_id = ? AND ((? != '' AND os_account_fingerprint != ?) OR (? != '' AND host_fingerprint != ?))`,
		account, account, host, host, deviceID, account, account, host, host)
	if err != nil {
		return false, fmt.Errorf("record device account identity: %w", err)
	}
	changed, err := result.RowsAffected()
	return changed > 0, err
}

func (s *Store) ListDeviceAccountShares(ctx context.Context) (map[string][]store.DeviceAccountShare, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT a.device_id, b.device_id,
			COALESCE(json_extract(d.payload_json, '$.label'), r.label, b.device_id),
			COALESCE(NULLIF(u.display_name, ''), u.username),
			s.device_id, s.accepted_at, COALESCE(NULLIF(au.display_name, ''), au.username), s.notice_seen_at
		FROM device_identities AS a
		JOIN device_identities AS b ON b.os_account_fingerprint = a.os_account_fingerprint
			AND b.owner_user_id != a.owner_user_id AND b.device_id != a.device_id
		JOIN users AS u ON u.id = b.owner_user_id
		LEFT JOIN devices AS d ON d.id = b.device_id
		LEFT JOIN removed_devices AS r ON r.device_id = b.device_id
		LEFT JOIN device_account_shares AS s
			ON (s.device_id = a.device_id AND s.shared_device_id = b.device_id)
			OR (s.device_id = b.device_id AND s.shared_device_id = a.device_id)
		LEFT JOIN users AS au ON au.id = s.accepted_by_user_id
		WHERE a.os_account_fingerprint != '' AND a.revoked_at IS NULL AND b.revoked_at IS NULL
			AND NOT EXISTS (SELECT 1 FROM removed_devices AS ra WHERE ra.device_id = a.device_id)
			AND r.device_id IS NULL
		ORDER BY a.device_id, b.paired_at, b.device_id`)
	if err != nil {
		return nil, fmt.Errorf("list shared system accounts: %w", err)
	}
	defer rows.Close()
	shares := map[string][]store.DeviceAccountShare{}
	for rows.Next() {
		var deviceID string
		var share store.DeviceAccountShare
		var laterDevice, acceptedAt, acceptedBy, noticeSeenAt sql.NullString
		if err := rows.Scan(&deviceID, &share.DeviceID, &share.DeviceLabel, &share.OwnerName,
			&laterDevice, &acceptedAt, &acceptedBy, &noticeSeenAt); err != nil {
			return nil, fmt.Errorf("scan shared system account: %w", err)
		}
		share.AcceptedAt, share.AcceptedBy = acceptedAt.String, acceptedBy.String
		// The device there first owes its owner a notice.
		share.NoticePending = laterDevice.Valid && laterDevice.String == share.DeviceID && !noticeSeenAt.Valid
		shares[deviceID] = append(shares[deviceID], share)
	}
	return shares, rows.Err()
}

func (s *Store) DismissDeviceAccountShareNotice(ctx context.Context, deviceID string) error {
	if _, err := s.conn().ExecContext(ctx, `UPDATE device_account_shares SET notice_seen_at = ?
		WHERE shared_device_id = ? AND notice_seen_at IS NULL`, formatTime(time.Now().UTC()), deviceID); err != nil {
		return fmt.Errorf("dismiss shared system account notice: %w", err)
	}
	return nil
}

func (s *Store) DevicePairingStatus(ctx context.Context, tokenHash, userID string) (store.DevicePairingStatus, error) {
	var expiresAt, consent, sharedWith string
	var usedAt, usedBy sql.NullString
	err := s.conn().QueryRowContext(ctx, `SELECT expires_at, used_at, used_by_device_id, consent, shared_with_json
		FROM device_pairing_tokens WHERE token_hash = ? AND user_id = ?`, tokenHash, userID).
		Scan(&expiresAt, &usedAt, &usedBy, &consent, &sharedWith)
	if errors.Is(err, sql.ErrNoRows) {
		return store.DevicePairingStatus{}, store.ErrNotFound
	}
	if err != nil {
		return store.DevicePairingStatus{}, fmt.Errorf("read device pairing token: %w", err)
	}
	switch {
	case usedAt.Valid:
		return store.DevicePairingStatus{State: store.DevicePairingPaired, DeviceID: usedBy.String}, nil
	case consent == pairingConsentCancelled:
		return store.DevicePairingStatus{State: store.DevicePairingCancelled}, nil
	case !time.Now().UTC().Before(parseStoredTime(expiresAt)):
		return store.DevicePairingStatus{State: store.DevicePairingExpired}, nil
	case consent == pairingConsentNeeded:
		status := store.DevicePairingStatus{State: store.DevicePairingNeedsConsent}
		_ = json.Unmarshal([]byte(sharedWith), &status.SharedWith)
		return status, nil
	}
	return store.DevicePairingStatus{State: store.DevicePairingWaiting}, nil
}

func (s *Store) SetDevicePairingConsent(ctx context.Context, tokenHash, userID string, accept bool) (store.DevicePairingStatus, error) {
	status, err := s.DevicePairingStatus(ctx, tokenHash, userID)
	if err != nil || status.State != store.DevicePairingNeedsConsent {
		return status, err
	}
	consent := pairingConsentCancelled
	if accept {
		consent = pairingConsentAccepted
	}
	if _, err := s.conn().ExecContext(ctx, `UPDATE device_pairing_tokens SET consent = ?
		WHERE token_hash = ? AND user_id = ? AND consent = ? AND used_at IS NULL`,
		consent, tokenHash, userID, pairingConsentNeeded); err != nil {
		return store.DevicePairingStatus{}, fmt.Errorf("record pairing consent: %w", err)
	}
	return s.DevicePairingStatus(ctx, tokenHash, userID)
}
