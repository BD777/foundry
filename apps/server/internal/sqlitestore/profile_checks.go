package sqlitestore

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// setupProfileChecks adds the explicit checks of server profiles, one per
// profile and device it is assigned to: whether a short conversation through
// the device's own agent SDK answered with that profile.
func (s *Store) setupProfileChecks(ctx context.Context) error {
	if _, err := s.conn().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS profile_checks (
		profile_id TEXT NOT NULL,
		device_id TEXT NOT NULL,
		status TEXT NOT NULL,
		checked_at TEXT NOT NULL,
		message TEXT NOT NULL DEFAULT '',
		reason TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (profile_id, device_id)
	)`); err != nil {
		return fmt.Errorf("migrate sqlite profile checks: %w", err)
	}
	return nil
}

// SaveProfileCheck keeps the newest check of a profile on a device. A check
// of a profile the device is not assigned is not kept.
func (s *Store) SaveProfileCheck(ctx context.Context, profileID, deviceID string, check store.AgentProfileCheck) error {
	profileID, deviceID = strings.TrimSpace(profileID), strings.TrimSpace(deviceID)
	if profileID == "" || deviceID == "" || check.Status == "" || check.CheckedAt == "" {
		return errors.New("a profile check needs a profile, a device, a status and a time")
	}
	_, err := s.conn().ExecContext(ctx, `
		INSERT INTO profile_checks (profile_id, device_id, status, checked_at, message, reason)
		SELECT profile_id, device_id, ?, ?, ?, ? FROM device_profiles
		WHERE profile_id = ? AND device_id = ? AND enabled = 1
		ON CONFLICT(profile_id, device_id) DO UPDATE SET
			status = excluded.status,
			checked_at = excluded.checked_at,
			message = excluded.message,
			reason = excluded.reason`,
		check.Status, check.CheckedAt, check.Message, check.Reason, profileID, deviceID)
	if err != nil {
		return fmt.Errorf("save check of %s on %s: %w", profileID, deviceID, err)
	}
	return nil
}

// ListProfileChecks returns the checks of profiles still assigned to their
// device, keyed by store.ProfileCheckKey.
func (s *Store) ListProfileChecks(ctx context.Context) (map[string]store.AgentProfileCheck, error) {
	rows, err := s.reader().QueryContext(ctx, `
		SELECT checks.profile_id, checks.device_id, checks.status, checks.checked_at, checks.message, checks.reason
		FROM profile_checks AS checks
		JOIN device_profiles AS bound
			ON bound.profile_id = checks.profile_id AND bound.device_id = checks.device_id AND bound.enabled = 1`)
	if err != nil {
		return nil, fmt.Errorf("list profile checks: %w", err)
	}
	defer rows.Close()
	checks := map[string]store.AgentProfileCheck{}
	for rows.Next() {
		var profileID, deviceID string
		var check store.AgentProfileCheck
		if err := rows.Scan(&profileID, &deviceID, &check.Status, &check.CheckedAt, &check.Message, &check.Reason); err != nil {
			return nil, fmt.Errorf("list profile checks: %w", err)
		}
		checks[store.ProfileCheckKey(profileID, deviceID)] = check
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list profile checks: %w", err)
	}
	return checks, nil
}

// ForgetProfileChecks drops a profile's checks: what was checked is no
// longer what runs.
func (s *Store) ForgetProfileChecks(ctx context.Context, profileID string) error {
	return forgetProfileChecks(ctx, s.conn(), profileID)
}

func forgetProfileChecks(ctx context.Context, db dbExecutor, profileID string) error {
	if _, err := db.ExecContext(ctx, `DELETE FROM profile_checks WHERE profile_id = ?`, profileID); err != nil {
		return fmt.Errorf("forget checks of %s: %w", profileID, err)
	}
	return nil
}
