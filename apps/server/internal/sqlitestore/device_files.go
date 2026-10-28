package sqlitestore

import (
	"context"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// setupDeviceFiles creates the owners' switches for opening a device's
// files outside its workspaces, and the record of each opening (times in
// Unix milliseconds). The record keeps paths and outcomes, never contents.
func (s *Store) setupDeviceFiles(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS device_outside_files (
			device_id TEXT PRIMARY KEY,
			off INTEGER NOT NULL DEFAULT 0,
			updated_by TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS device_file_access (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			device_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			path TEXT NOT NULL,
			action TEXT NOT NULL,
			result TEXT NOT NULL,
			bytes INTEGER NOT NULL DEFAULT 0,
			at_ms INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_device_file_access_device ON device_file_access (device_id, at_ms)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite device files: %w", err)
		}
	}
	return nil
}

func (s *Store) DevicesWithOutsideFilesOff(ctx context.Context, deviceIDs []string) (map[string]bool, error) {
	off := map[string]bool{}
	if len(deviceIDs) == 0 {
		return off, nil
	}
	placeholders, args := inPlaceholders(deviceIDs)
	rows, err := s.reader().QueryContext(ctx, `SELECT device_id FROM device_outside_files
		WHERE off = 1 AND device_id IN (`+placeholders+`)`, args...)
	if err != nil {
		return nil, fmt.Errorf("list device outside files: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var deviceID string
		if err := rows.Scan(&deviceID); err != nil {
			return nil, err
		}
		off[deviceID] = true
	}
	return off, rows.Err()
}

func (s *Store) SetDeviceOutsideFilesOff(ctx context.Context, deviceID string, off bool, userID string) error {
	return s.withTx(ctx, func(tx *Store) error {
		if err := tx.assertDeviceNotRemoved(ctx, deviceID); err != nil {
			return err
		}
		value := 0
		if off {
			value = 1
		}
		_, err := tx.conn().ExecContext(ctx, `INSERT INTO device_outside_files (device_id, off, updated_by, updated_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(device_id) DO UPDATE SET off = excluded.off, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
			deviceID, value, userID, time.Now().UTC().Format(time.RFC3339Nano))
		if err != nil {
			return fmt.Errorf("set device outside files: %w", err)
		}
		return nil
	})
}

func (s *Store) RecordDeviceFileAccess(ctx context.Context, access store.DeviceFileAccess) error {
	at := access.At
	if at.IsZero() {
		at = time.Now()
	}
	return s.withTx(ctx, func(tx *Store) error {
		if _, err := tx.conn().ExecContext(ctx, `INSERT INTO device_file_access
			(device_id, user_id, path, action, result, bytes, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			access.DeviceID, access.UserID, access.Path, access.Action, access.Result, access.Bytes, at.UnixMilli()); err != nil {
			return fmt.Errorf("record device file access: %w", err)
		}
		_, err := tx.conn().ExecContext(ctx, `DELETE FROM device_file_access WHERE device_id = ? AND at_ms < ?`,
			access.DeviceID, at.Add(-store.DeviceFileAccessRetention).UnixMilli())
		if err != nil {
			return fmt.Errorf("prune device file access: %w", err)
		}
		return nil
	})
}

func (s *Store) ListDeviceFileAccess(ctx context.Context, deviceID string, limit int) ([]store.DeviceFileAccess, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.reader().QueryContext(ctx, `SELECT device_id, user_id, path, action, result, bytes, at_ms
		FROM device_file_access WHERE device_id = ? ORDER BY at_ms DESC, id DESC LIMIT ?`, deviceID, limit)
	if err != nil {
		return nil, fmt.Errorf("list device file access: %w", err)
	}
	defer rows.Close()
	list := []store.DeviceFileAccess{}
	for rows.Next() {
		var access store.DeviceFileAccess
		var atMs int64
		if err := rows.Scan(&access.DeviceID, &access.UserID, &access.Path, &access.Action, &access.Result, &access.Bytes, &atMs); err != nil {
			return nil, err
		}
		access.At = time.UnixMilli(atMs).UTC()
		list = append(list, access)
	}
	return list, rows.Err()
}
