package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Leases, waits, fences and the operation audit (store.ResourceLeaseStore).
// Package resources decides; one partial unique index still refuses a
// second live lease on an instance, whatever a bug decides.
func (s *Store) setupResourceLeases(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS resource_leases (
			id TEXT PRIMARY KEY,
			resource_id TEXT NOT NULL,
			source_id TEXT NOT NULL,
			generation INTEGER NOT NULL,
			holder_session_id TEXT NOT NULL,
			holder_user_id TEXT NOT NULL DEFAULT '',
			holder_device_id TEXT NOT NULL DEFAULT '',
			reason TEXT NOT NULL DEFAULT '',
			state TEXT NOT NULL,
			acquired_at TEXT NOT NULL,
			park_until TEXT NOT NULL DEFAULT '',
			hold_until TEXT NOT NULL DEFAULT '',
			contended_since TEXT NOT NULL DEFAULT '',
			preempt_at TEXT NOT NULL DEFAULT '',
			warned_at TEXT NOT NULL DEFAULT '',
			extended INTEGER NOT NULL DEFAULT 0,
			holder_offline_since TEXT NOT NULL DEFAULT '',
			ended_at TEXT NOT NULL DEFAULT '',
			end_reason TEXT NOT NULL DEFAULT '',
			ended_by TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_leases_live ON resource_leases (resource_id) WHERE state IN ('active', 'parked')`,
		`CREATE INDEX IF NOT EXISTS idx_resource_leases_session ON resource_leases (holder_session_id, state)`,
		`CREATE TABLE IF NOT EXISTS resource_fences (
			resource_id TEXT PRIMARY KEY,
			source_id TEXT NOT NULL,
			generation INTEGER NOT NULL,
			resetting INTEGER NOT NULL DEFAULT 0,
			reset_since TEXT NOT NULL DEFAULT '',
			reset_reason TEXT NOT NULL DEFAULT '',
			unconfirmed INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS resource_waits (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			user_id TEXT NOT NULL DEFAULT '',
			device_id TEXT NOT NULL DEFAULT '',
			resource_ids_json TEXT NOT NULL,
			reason TEXT NOT NULL DEFAULT '',
			hold_until TEXT NOT NULL DEFAULT '',
			enqueued_at TEXT NOT NULL,
			retain_until TEXT NOT NULL,
			state TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_resource_waits_state ON resource_waits (state)`,
		`CREATE TABLE IF NOT EXISTS resource_operations (
			id TEXT PRIMARY KEY,
			lease_id TEXT NOT NULL,
			resource_id TEXT NOT NULL,
			source_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			user_id TEXT NOT NULL DEFAULT '',
			op TEXT NOT NULL,
			args_json TEXT NOT NULL DEFAULT '{}',
			status TEXT NOT NULL,
			error_code TEXT NOT NULL DEFAULT '',
			started_at TEXT NOT NULL,
			duration_ms INTEGER NOT NULL DEFAULT 0,
			bytes_out INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE INDEX IF NOT EXISTS idx_resource_operations_resource ON resource_operations (resource_id, started_at)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite resource leases: %w", err)
		}
	}
	return s.ensureColumn(ctx, "resource_operations", "outcome_json",
		`ALTER TABLE resource_operations ADD COLUMN outcome_json TEXT NOT NULL DEFAULT '{}'`)
}

const resourceLeaseColumns = `id, resource_id, source_id, generation, holder_session_id, holder_user_id, holder_device_id,
	reason, state, acquired_at, park_until, hold_until, contended_since, preempt_at, warned_at, extended,
	holder_offline_since, ended_at, end_reason, ended_by, updated_at`

func (s *Store) ListResourceLeases(ctx context.Context, filter store.ResourceLeaseFilter) ([]store.ResourceLease, error) {
	query := `SELECT ` + resourceLeaseColumns + ` FROM resource_leases WHERE 1 = 1`
	var args []any
	if filter.ID != "" {
		query += ` AND id = ?`
		args = append(args, filter.ID)
	}
	if filter.ResourceID != "" {
		query += ` AND resource_id = ?`
		args = append(args, filter.ResourceID)
	}
	if filter.SessionID != "" {
		query += ` AND holder_session_id = ?`
		args = append(args, filter.SessionID)
	}
	if filter.SourceID != "" {
		query += ` AND source_id = ?`
		args = append(args, filter.SourceID)
	}
	if filter.Live {
		query += ` AND state IN ('active', 'parked')`
	}
	query += ` ORDER BY acquired_at, id`
	leases := []store.ResourceLease{}
	err := scanRows(ctx, s.reader(), query, func(rows *sql.Rows) error {
		var (
			lease    store.ResourceLease
			extended int
		)
		if err := rows.Scan(&lease.ID, &lease.ResourceID, &lease.SourceID, &lease.Generation, &lease.HolderSessionID,
			&lease.HolderUserID, &lease.HolderDeviceID, &lease.Reason, &lease.State, &lease.AcquiredAt, &lease.ParkUntil,
			&lease.HoldUntil, &lease.ContendedSince, &lease.PreemptAt, &lease.WarnedAt, &extended, &lease.HolderOfflineSince,
			&lease.EndedAt, &lease.EndReason, &lease.EndedBy, &lease.UpdatedAt); err != nil {
			return err
		}
		lease.Extended = extended != 0
		leases = append(leases, lease)
		return nil
	}, args...)
	return leases, err
}

func (s *Store) ListResourceFences(ctx context.Context) ([]store.ResourceFence, error) {
	fences := []store.ResourceFence{}
	err := scanRows(ctx, s.reader(), `SELECT resource_id, source_id, generation, resetting, reset_since, reset_reason, unconfirmed
		FROM resource_fences ORDER BY resource_id`, func(rows *sql.Rows) error {
		var (
			fence                  store.ResourceFence
			resetting, unconfirmed int
		)
		if err := rows.Scan(&fence.ResourceID, &fence.SourceID, &fence.Generation, &resetting, &fence.ResetSince,
			&fence.ResetReason, &unconfirmed); err != nil {
			return err
		}
		fence.Resetting, fence.Unconfirmed = resetting != 0, unconfirmed != 0
		fences = append(fences, fence)
		return nil
	})
	return fences, err
}

func (s *Store) ListResourceWaits(ctx context.Context) ([]store.ResourceWait, error) {
	waits := []store.ResourceWait{}
	err := scanRows(ctx, s.reader(), `SELECT id, session_id, user_id, device_id, resource_ids_json, reason, hold_until,
		enqueued_at, retain_until, state FROM resource_waits WHERE state = 'waiting' ORDER BY rowid`, func(rows *sql.Rows) error {
		var (
			wait store.ResourceWait
			ids  string
		)
		if err := rows.Scan(&wait.ID, &wait.SessionID, &wait.UserID, &wait.DeviceID, &ids, &wait.Reason, &wait.HoldUntil,
			&wait.EnqueuedAt, &wait.RetainUntil, &wait.State); err != nil {
			return err
		}
		if err := json.Unmarshal([]byte(ids), &wait.ResourceIDs); err != nil {
			return fmt.Errorf("resource wait %s: %w", wait.ID, err)
		}
		waits = append(waits, wait)
		return nil
	})
	return waits, err
}

func (s *Store) SaveResourceLeaseChanges(ctx context.Context, changes store.ResourceLeaseChanges) error {
	return s.withTx(ctx, func(tx *Store) error {
		// Ended leases first: one that ends frees its instance for one that
		// starts in the same decision.
		ordered := make([]store.ResourceLease, 0, len(changes.Leases))
		for _, lease := range changes.Leases {
			if !store.LeaseLive(lease.State) {
				ordered = append(ordered, lease)
			}
		}
		for _, lease := range changes.Leases {
			if store.LeaseLive(lease.State) {
				ordered = append(ordered, lease)
			}
		}
		for _, lease := range ordered {
			if store.LeaseLive(lease.State) {
				if err := tx.assertDeviceNotRemoved(ctx, lease.SourceID); err != nil {
					return err
				}
				if err := tx.assertDeviceNotRemoved(ctx, lease.HolderDeviceID); err != nil {
					return err
				}
			}
			if _, err := tx.conn().ExecContext(ctx, `INSERT INTO resource_leases (`+resourceLeaseColumns+`)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET state = excluded.state, park_until = excluded.park_until,
					hold_until = excluded.hold_until, contended_since = excluded.contended_since,
					preempt_at = excluded.preempt_at, warned_at = excluded.warned_at, extended = excluded.extended,
					holder_offline_since = excluded.holder_offline_since, ended_at = excluded.ended_at,
					end_reason = excluded.end_reason, ended_by = excluded.ended_by, updated_at = excluded.updated_at`,
				lease.ID, lease.ResourceID, lease.SourceID, lease.Generation, lease.HolderSessionID, lease.HolderUserID,
				lease.HolderDeviceID, lease.Reason, lease.State, lease.AcquiredAt, lease.ParkUntil, lease.HoldUntil,
				lease.ContendedSince, lease.PreemptAt, lease.WarnedAt, boolInt(lease.Extended), lease.HolderOfflineSince,
				lease.EndedAt, lease.EndReason, lease.EndedBy, lease.UpdatedAt); err != nil {
				return fmt.Errorf("save resource lease %s: %w", lease.ID, err)
			}
		}
		for _, fence := range changes.Fences {
			if _, err := tx.conn().ExecContext(ctx, `INSERT INTO resource_fences
				(resource_id, source_id, generation, resetting, reset_since, reset_reason, unconfirmed)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(resource_id) DO UPDATE SET source_id = excluded.source_id,
					generation = max(resource_fences.generation, excluded.generation), resetting = excluded.resetting,
					reset_since = excluded.reset_since, reset_reason = excluded.reset_reason, unconfirmed = excluded.unconfirmed`,
				fence.ResourceID, fence.SourceID, fence.Generation, boolInt(fence.Resetting), fence.ResetSince,
				fence.ResetReason, boolInt(fence.Unconfirmed)); err != nil {
				return fmt.Errorf("save resource fence %s: %w", fence.ResourceID, err)
			}
		}
		for _, wait := range changes.Waits {
			ids, err := json.Marshal(nonNil(wait.ResourceIDs))
			if err != nil {
				return err
			}
			if _, err := tx.conn().ExecContext(ctx, `INSERT INTO resource_waits
				(id, session_id, user_id, device_id, resource_ids_json, reason, hold_until, enqueued_at, retain_until, state)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET retain_until = excluded.retain_until, state = excluded.state,
					hold_until = excluded.hold_until`,
				wait.ID, wait.SessionID, wait.UserID, wait.DeviceID, string(ids), wait.Reason, wait.HoldUntil,
				wait.EnqueuedAt, wait.RetainUntil, wait.State); err != nil {
				return fmt.Errorf("save resource wait %s: %w", wait.ID, err)
			}
		}
		return nil
	})
}

func (s *Store) DeleteEndedResourceLeases(ctx context.Context, before time.Time) (int64, error) {
	cutoff := formatTime(before)
	var deleted int64
	err := s.withTx(ctx, func(tx *Store) error {
		result, err := tx.conn().ExecContext(ctx, `DELETE FROM resource_leases WHERE state NOT IN ('active', 'parked') AND ended_at <> '' AND ended_at < ?`, cutoff)
		if err != nil {
			return fmt.Errorf("delete ended resource leases: %w", err)
		}
		deleted, _ = result.RowsAffected()
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM resource_waits WHERE state <> 'waiting' AND retain_until < ?`, cutoff); err != nil {
			return fmt.Errorf("delete ended resource waits: %w", err)
		}
		return nil
	})
	return deleted, err
}

func (s *Store) RecordResourceOperation(ctx context.Context, record store.ResourceOperationRecord) error {
	args, err := jsonObject(record.Args)
	if err != nil {
		return err
	}
	outcome, err := jsonObject(record.Outcome)
	if err != nil {
		return err
	}
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO resource_operations
		(id, lease_id, resource_id, source_id, session_id, user_id, op, args_json, status, error_code, started_at,
		 duration_ms, bytes_out, outcome_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		record.ID, record.LeaseID, record.ResourceID, record.SourceID, record.SessionID, record.UserID, record.Op,
		args, record.Status, record.ErrorCode, record.StartedAt, record.DurationMs, record.BytesOut, outcome); err != nil {
		return fmt.Errorf("record resource operation: %w", err)
	}
	return nil
}

func (s *Store) ListResourceOperations(ctx context.Context, resourceID string, limit int) ([]store.ResourceOperationRecord, error) {
	if limit <= 0 {
		limit = 100
	}
	records := []store.ResourceOperationRecord{}
	err := scanRows(ctx, s.reader(), `SELECT id, lease_id, resource_id, source_id, session_id, user_id, op, args_json, status,
		error_code, started_at, duration_ms, bytes_out, outcome_json FROM resource_operations WHERE resource_id = ?
		ORDER BY started_at DESC, id DESC LIMIT ?`, func(rows *sql.Rows) error {
		var (
			record        store.ResourceOperationRecord
			args, outcome string
		)
		if err := rows.Scan(&record.ID, &record.LeaseID, &record.ResourceID, &record.SourceID, &record.SessionID,
			&record.UserID, &record.Op, &args, &record.Status, &record.ErrorCode, &record.StartedAt, &record.DurationMs,
			&record.BytesOut, &outcome); err != nil {
			return err
		}
		if err := json.Unmarshal([]byte(args), &record.Args); err != nil {
			return fmt.Errorf("resource operation %s: %w", record.ID, err)
		}
		if err := json.Unmarshal([]byte(outcome), &record.Outcome); err != nil {
			return fmt.Errorf("resource operation %s outcome: %w", record.ID, err)
		}
		if len(record.Args) == 0 {
			record.Args = nil
		}
		if len(record.Outcome) == 0 {
			record.Outcome = nil
		}
		records = append(records, record)
		return nil
	}, resourceID, limit)
	return records, err
}

func (s *Store) DeleteResourceOperations(ctx context.Context, before time.Time) (int64, error) {
	result, err := s.conn().ExecContext(ctx, `DELETE FROM resource_operations WHERE started_at < ?`, formatTime(before))
	if err != nil {
		return 0, fmt.Errorf("delete resource operations: %w", err)
	}
	return result.RowsAffected()
}

// jsonObject encodes a map as a JSON object, an empty one when it is.
func jsonObject(values map[string]any) (string, error) {
	if len(values) == 0 {
		return "{}", nil
	}
	encoded, err := json.Marshal(values)
	return string(encoded), err
}
