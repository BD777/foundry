package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const removedDeviceLabel = "Removed from Foundry"

// SoftRemoveDevice tombstones a device. No history rows are deleted: chats,
// issues, runs, agent sessions and workspace registrations all stay readable.
// The device disappears from the available device list (ListDevices marks it
// "removed") and every work-creation gate refuses it, so a reconnecting worker
// can neither resurrect the device nor start new tasks on it.
//
// The busy check and the tombstone insert share one transaction. Every path
// that starts non-terminal work on a device (claim, run start, session
// create/start) goes through assertDeviceNotRemoved inside its own write
// transaction. Serialized on the single writer, the two outcomes are clean:
// the work commits first and removal fails with ErrDeviceBusy, or the
// tombstone commits first and the work fails with ErrDeviceRemoved.
func (s *Store) SoftRemoveDevice(ctx context.Context, id string) (store.DeviceProjection, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return store.DeviceProjection{}, store.ErrNotFound
	}
	var device store.DeviceProjection
	err := s.withTx(ctx, func(tx *Store) error {
		d, err := getJSON[store.DeviceProjection](ctx, tx.conn(),
			`SELECT payload_json FROM devices WHERE id = ?`, id)
		if err != nil {
			return err
		}
		removed, err := tx.isDeviceRemoved(ctx, id)
		if err != nil {
			return err
		}
		if removed {
			// Idempotent retries succeed without rechecking active work.
			device = markDeviceRemoved(d)
			return nil
		}
		var (
			activeRuns          int
			activeSessions      int
			inProgressIssues    int
			queuedIssues        int
			activeVerifications int
		)
		deviceWorkspacesSQL := `SELECT id FROM workspaces WHERE json_extract(payload_json, '$.deviceId') = ?`
		if err := tx.conn().QueryRowContext(ctx,
			`SELECT count(*) FROM runs
				WHERE status NOT IN ('completed','failed','canceled','cancelled')
				AND workspace_id IN (`+deviceWorkspacesSQL+`)`, id).Scan(&activeRuns); err != nil {
			return err
		}
		if err := tx.conn().QueryRowContext(ctx,
			`SELECT count(*) FROM agent_sessions
				WHERE status NOT IN ('completed','failed','canceled','cancelled')
				AND device_id = ?`, id).Scan(&activeSessions); err != nil {
			return err
		}
		if err := tx.conn().QueryRowContext(ctx,
			`SELECT count(*) FROM issues WHERE status = 'in_progress'
				AND workspace_id IN (`+deviceWorkspacesSQL+`)`, id).Scan(&inProgressIssues); err != nil {
			return err
		}
		// Confirmed pending/ready issues are queued dispatchable work. They must
		// block removal instead of becoming permanently unclaimable orphans.
		if err := tx.conn().QueryRowContext(ctx,
			`SELECT count(*) FROM issues
				WHERE status IN ('pending','ready')
				AND json_extract(payload_json, '$.contractState') = 'confirmed'
				AND workspace_id IN (`+deviceWorkspacesSQL+`)`, id).Scan(&queuedIssues); err != nil {
			return err
		}
		// Verifications run real assess/collect agents on the worker for up to
		// 15 minutes; a queued or running verification is active device work even
		// when the issue has already left "in_progress" for "verifying".
		if err := tx.conn().QueryRowContext(ctx,
			`SELECT count(*) FROM evidence_records
				WHERE kind = 'verification'
				AND json_extract(payload_json, '$.status') IN ('queued','running')
				AND workspace_id IN (`+deviceWorkspacesSQL+`)`, id).Scan(&activeVerifications); err != nil {
			return err
		}
		if activeRuns+activeSessions+inProgressIssues+queuedIssues+activeVerifications > 0 {
			return fmt.Errorf(
				"%w: %d active run(s), %d active agent session(s), %d in-progress issue(s), %d queued issue(s), %d running or queued verification(s)",
				store.ErrDeviceBusy,
				activeRuns, activeSessions, inProgressIssues, queuedIssues, activeVerifications,
			)
		}
		if _, err := tx.conn().ExecContext(ctx,
			`INSERT INTO removed_devices (device_id, label, removed_at) VALUES (?, ?, ?)`,
			id, d.Label, formatTime(time.Now().UTC())); err != nil {
			return fmt.Errorf("tombstone device: %w", err)
		}
		// The removed device's credential dies with it; re-pairing issues a
		// new device id and credential.
		if err := tx.RevokeDeviceCredential(ctx, id); err != nil {
			return err
		}
		device = markDeviceRemoved(d)
		return nil
	})
	if err != nil {
		return store.DeviceProjection{}, err
	}
	return device, nil
}

func markDeviceRemoved(device store.DeviceProjection) store.DeviceProjection {
	device.Status = "removed"
	device.LastSeenLabel = removedDeviceLabel
	return device
}

// DeviceRemoved reports whether the device is tombstoned. Safe to call on any
// executor (pool handle or transaction clone).
func (s *Store) DeviceRemoved(ctx context.Context, deviceID string) (bool, error) {
	return s.isDeviceRemoved(ctx, deviceID)
}

func (s *Store) isDeviceRemoved(ctx context.Context, deviceID string) (bool, error) {
	var found int
	err := s.conn().QueryRowContext(ctx,
		`SELECT 1 FROM removed_devices WHERE device_id = ? LIMIT 1`, deviceID).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// assertDeviceNotRemoved is the centralized work-creation gate. Every store
// path that starts new execution on a device must call it (through the
// transaction clone, so the check and the work insertion share one serialized
// transaction) before committing non-terminal work.
func (s *Store) assertDeviceNotRemoved(ctx context.Context, deviceID string) error {
	deviceID = strings.TrimSpace(deviceID)
	if deviceID == "" {
		return nil
	}
	var found int
	err := s.conn().QueryRowContext(ctx,
		`SELECT 1 FROM removed_devices WHERE device_id = ? LIMIT 1`, deviceID).Scan(&found)
	switch {
	case err == nil:
		return store.ErrDeviceRemoved
	case errors.Is(err, sql.ErrNoRows):
		return nil
	default:
		return err
	}
}

// assertWorkspaceDeviceNotRemoved gates work addressed by workspace id, which
// is how issues/runs identify their execution target.
func (s *Store) assertWorkspaceDeviceNotRemoved(ctx context.Context, workspaceID string) error {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return nil
	}
	var deviceID string
	err := s.conn().QueryRowContext(ctx,
		`SELECT COALESCE(json_extract(payload_json, '$.deviceId'), '') FROM workspaces WHERE id = ?`,
		workspaceID).Scan(&deviceID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return s.assertDeviceNotRemoved(ctx, deviceID)
}
