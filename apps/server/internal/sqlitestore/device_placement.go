package sqlitestore

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// setupDevicePlacement creates what decides where work may go: the labels
// a device's owner set, and the device's connections (times in Unix
// milliseconds), from which its online share is computed.
func (s *Store) setupDevicePlacement(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS device_labels (
			device_id TEXT PRIMARY KEY,
			labels_json TEXT NOT NULL DEFAULT '[]',
			updated_by TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS device_presence (
			device_id TEXT NOT NULL,
			started_ms INTEGER NOT NULL,
			last_seen_ms INTEGER NOT NULL,
			PRIMARY KEY (device_id, started_ms)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_device_presence_last_seen ON device_presence (last_seen_ms)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite device placement: %w", err)
		}
	}
	return nil
}

func inPlaceholders(ids []string) (string, []any) {
	args := make([]any, 0, len(ids))
	for _, id := range ids {
		args = append(args, id)
	}
	return strings.TrimSuffix(strings.Repeat("?,", len(ids)), ","), args
}

func (s *Store) ListDeviceLabels(ctx context.Context, deviceIDs []string) ([]store.DeviceLabelSet, error) {
	sets := []store.DeviceLabelSet{}
	if len(deviceIDs) == 0 {
		return sets, nil
	}
	placeholders, args := inPlaceholders(deviceIDs)
	rows, err := s.reader().QueryContext(ctx, `SELECT device_id, labels_json, updated_by, updated_at
		FROM device_labels WHERE device_id IN (`+placeholders+`) ORDER BY device_id`, args...)
	if err != nil {
		return nil, fmt.Errorf("list device labels: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var set store.DeviceLabelSet
		var labels string
		if err := rows.Scan(&set.DeviceID, &labels, &set.UpdatedBy, &set.UpdatedAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(labels), &set.Labels); err != nil {
			return nil, fmt.Errorf("device %s labels: %w", set.DeviceID, err)
		}
		sets = append(sets, set)
	}
	return sets, rows.Err()
}

func (s *Store) SetDeviceLabels(ctx context.Context, deviceID string, labels []store.DeviceLabel, userID string) error {
	return s.withTx(ctx, func(tx *Store) error {
		if err := tx.assertDeviceNotRemoved(ctx, deviceID); err != nil {
			return err
		}
		return tx.setDeviceLabels(ctx, deviceID, labels, userID)
	})
}
func (s *Store) setDeviceLabels(ctx context.Context, deviceID string, labels []store.DeviceLabel, userID string) error {
	if strings.TrimSpace(deviceID) == "" {
		return fmt.Errorf("device labels need a device")
	}
	if len(labels) == 0 {
		_, err := s.conn().ExecContext(ctx, `DELETE FROM device_labels WHERE device_id = ?`, deviceID)
		return err
	}
	encoded, err := json.Marshal(labels)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO device_labels (device_id, labels_json, updated_by, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(device_id) DO UPDATE SET labels_json = excluded.labels_json,
			updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
		deviceID, string(encoded), userID, formatTime(time.Now()))
	if err != nil {
		return fmt.Errorf("save device labels: %w", err)
	}
	return nil
}

func (s *Store) RecordDevicePresence(ctx context.Context, deviceID string, startedAt, lastSeenAt time.Time) error {
	if lastSeenAt.Before(startedAt) {
		lastSeenAt = startedAt
	}
	_, err := s.conn().ExecContext(ctx, `INSERT INTO device_presence (device_id, started_ms, last_seen_ms) VALUES (?, ?, ?)
		ON CONFLICT(device_id, started_ms) DO UPDATE SET last_seen_ms = MAX(last_seen_ms, excluded.last_seen_ms)`,
		deviceID, startedAt.UnixMilli(), lastSeenAt.UnixMilli())
	if err != nil {
		return fmt.Errorf("record device presence: %w", err)
	}
	return nil
}

func (s *Store) ListDevicePresence(ctx context.Context, deviceIDs []string, since time.Time) ([]store.DevicePresenceInterval, error) {
	intervals := []store.DevicePresenceInterval{}
	if len(deviceIDs) == 0 {
		return intervals, nil
	}
	placeholders, args := inPlaceholders(deviceIDs)
	args = append(args, since.UnixMilli())
	rows, err := s.reader().QueryContext(ctx, `SELECT device_id, started_ms, last_seen_ms FROM device_presence
		WHERE device_id IN (`+placeholders+`) AND last_seen_ms >= ? ORDER BY started_ms, device_id`, args...)
	if err != nil {
		return nil, fmt.Errorf("list device presence: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var interval store.DevicePresenceInterval
		var started, lastSeen int64
		if err := rows.Scan(&interval.DeviceID, &started, &lastSeen); err != nil {
			return nil, err
		}
		interval.StartedAt, interval.LastSeenAt = time.UnixMilli(started).UTC(), time.UnixMilli(lastSeen).UTC()
		intervals = append(intervals, interval)
	}
	return intervals, rows.Err()
}

func (s *Store) PruneDevicePresence(ctx context.Context, before time.Time) error {
	if _, err := s.conn().ExecContext(ctx, `DELETE FROM device_presence WHERE last_seen_ms < ?`, before.UnixMilli()); err != nil {
		return fmt.Errorf("prune device presence: %w", err)
	}
	return nil
}
