package sqlitestore

import (
	"context"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) migrateDeviceTools(ctx context.Context) error {
	_, err := s.conn().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS device_tools (
		device_id TEXT NOT NULL,
		tool TEXT NOT NULL,
		available INTEGER NOT NULL,
		checked_at TEXT NOT NULL,
		PRIMARY KEY (device_id, tool)
	)`)
	if err != nil {
		return fmt.Errorf("migrate device tools: %w", err)
	}
	return s.ensureColumn(ctx, "device_tools", "version", `ALTER TABLE device_tools ADD COLUMN version TEXT NOT NULL DEFAULT ''`)
}

// ReplaceDeviceTools records which of the programs skills need a device
// has, and the versions Foundry installed there, replacing its previous
// answer.
func (s *Store) ReplaceDeviceTools(ctx context.Context, deviceID string, tools map[string]bool, versions map[string]string) error {
	now := formatTime(time.Now())
	return s.withTx(ctx, func(tx *Store) error {
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM device_tools WHERE device_id = ?`, deviceID); err != nil {
			return err
		}
		for tool, available := range tools {
			if _, err := tx.conn().ExecContext(ctx, `INSERT INTO device_tools (device_id, tool, available, checked_at, version) VALUES (?, ?, ?, ?, ?)`,
				deviceID, tool, available, now, versions[tool]); err != nil {
				return err
			}
		}
		for tool, version := range versions {
			if _, found := tools[tool]; found {
				continue
			}
			if _, err := tx.conn().ExecContext(ctx, `INSERT INTO device_tools (device_id, tool, available, checked_at, version) VALUES (?, ?, 1, ?, ?)`,
				deviceID, tool, now, version); err != nil {
				return err
			}
		}
		return nil
	})
}

// ListDeviceTools lists what devices reported; an empty id lists every
// device.
func (s *Store) ListDeviceTools(ctx context.Context, deviceID string) ([]store.DeviceTool, error) {
	query := `SELECT device_id, tool, available, checked_at, version FROM device_tools`
	args := []any{}
	if deviceID != "" {
		query += ` WHERE device_id = ?`
		args = append(args, deviceID)
	}
	rows, err := s.conn().QueryContext(ctx, query+` ORDER BY device_id, tool`, args...)
	if err != nil {
		return nil, fmt.Errorf("list device tools: %w", err)
	}
	defer rows.Close()
	tools := []store.DeviceTool{}
	for rows.Next() {
		var tool store.DeviceTool
		if err := rows.Scan(&tool.DeviceID, &tool.Tool, &tool.Available, &tool.CheckedAt, &tool.Version); err != nil {
			return nil, err
		}
		tools = append(tools, tool)
	}
	return tools, rows.Err()
}

// SetDeviceToolVersion records that Foundry installed a tool version on a
// device.
func (s *Store) SetDeviceToolVersion(ctx context.Context, deviceID, tool, version string) error {
	_, err := s.conn().ExecContext(ctx, `
		INSERT INTO device_tools (device_id, tool, available, checked_at, version) VALUES (?, ?, 1, ?, ?)
		ON CONFLICT (device_id, tool) DO UPDATE SET available = 1, checked_at = excluded.checked_at, version = excluded.version`,
		deviceID, tool, formatTime(time.Now()), version)
	return err
}
