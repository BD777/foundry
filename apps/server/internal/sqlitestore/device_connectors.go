package sqlitestore

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// setupDeviceConnectors creates what the server keeps of device-held
// connectors: per device and kind, what the device last read (never a
// credential), and which workspaces may use which device's login.
func (s *Store) setupDeviceConnectors(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS device_connector_states (
			device_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			status TEXT NOT NULL,
			status_detail TEXT NOT NULL DEFAULT '',
			installed INTEGER NOT NULL DEFAULT 0,
			version TEXT NOT NULL DEFAULT '',
			install_source TEXT NOT NULL DEFAULT '',
			latest_version TEXT NOT NULL DEFAULT '',
			signed_in INTEGER NOT NULL DEFAULT 0,
			identity TEXT NOT NULL DEFAULT '',
			sites TEXT NOT NULL DEFAULT '[]',
			expires_at TEXT NOT NULL DEFAULT '',
			checked_at TEXT NOT NULL,
			expiring_since TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (device_id, kind)
		)`,
		`CREATE TABLE IF NOT EXISTS device_connector_bindings (
			workspace_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			device_id TEXT NOT NULL,
			members INTEGER NOT NULL DEFAULT 0,
			granted_by TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (workspace_id, kind, device_id)
		)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite device connectors: %w", err)
		}
	}
	return nil
}

func (s *Store) SaveDeviceConnectorState(ctx context.Context, state store.DeviceConnectorState) error {
	return s.withTx(ctx, func(tx *Store) error {
		if err := tx.assertDeviceNotRemoved(ctx, state.DeviceID); err != nil {
			return err
		}
		return tx.saveDeviceConnectorState(ctx, state)
	})
}

func (s *Store) saveDeviceConnectorState(ctx context.Context, state store.DeviceConnectorState) error {
	if strings.TrimSpace(state.DeviceID) == "" || strings.TrimSpace(state.Kind) == "" {
		return fmt.Errorf("a device connector state needs a device and a kind")
	}
	sites, err := json.Marshal(nonNilStrings(state.Sites))
	if err != nil {
		return err
	}
	if state.CheckedAt == "" {
		state.CheckedAt = formatTime(time.Now())
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO device_connector_states
		(device_id, kind, status, status_detail, installed, version, install_source, latest_version,
		 signed_in, identity, sites, expires_at, checked_at, expiring_since)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(device_id, kind) DO UPDATE SET
			status = excluded.status, status_detail = excluded.status_detail,
			installed = excluded.installed, version = excluded.version,
			install_source = excluded.install_source, latest_version = excluded.latest_version,
			signed_in = excluded.signed_in, identity = excluded.identity, sites = excluded.sites,
			expires_at = excluded.expires_at, checked_at = excluded.checked_at,
			expiring_since = excluded.expiring_since`,
		state.DeviceID, state.Kind, state.Status, state.StatusDetail, state.Installed, state.Version,
		state.InstallSource, state.LatestVersion, state.SignedIn, state.Identity, string(sites),
		state.ExpiresAt, state.CheckedAt, state.ExpiringSince)
	if err != nil {
		return fmt.Errorf("save device connector state: %w", err)
	}
	return nil
}

func (s *Store) ListDeviceConnectorStates(ctx context.Context, deviceIDs []string) ([]store.DeviceConnectorState, error) {
	states := []store.DeviceConnectorState{}
	if len(deviceIDs) == 0 {
		return states, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(deviceIDs)), ",")
	args := make([]any, 0, len(deviceIDs))
	for _, id := range deviceIDs {
		args = append(args, id)
	}
	rows, err := s.reader().QueryContext(ctx, `SELECT device_id, kind, status, status_detail, installed, version,
		install_source, latest_version, signed_in, identity, sites, expires_at, checked_at, expiring_since
		FROM device_connector_states WHERE device_id IN (`+placeholders+`) ORDER BY device_id, kind`, args...)
	if err != nil {
		return nil, fmt.Errorf("list device connector states: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var state store.DeviceConnectorState
		var sites string
		if err := rows.Scan(&state.DeviceID, &state.Kind, &state.Status, &state.StatusDetail, &state.Installed,
			&state.Version, &state.InstallSource, &state.LatestVersion, &state.SignedIn, &state.Identity, &sites,
			&state.ExpiresAt, &state.CheckedAt, &state.ExpiringSince); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(sites), &state.Sites); err != nil {
			state.Sites = nil
		}
		states = append(states, state)
	}
	return states, rows.Err()
}

func (s *Store) SetWorkspaceDeviceConnectors(ctx context.Context, workspaceID, userID string, bindings []store.DeviceConnectorBindingInput) error {
	return s.withTx(ctx, func(tx *Store) error {
		if len(bindings) > 0 {
			if err := tx.assertWorkspaceDeviceNotRemoved(ctx, workspaceID); err != nil {
				return err
			}
		}
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM device_connector_bindings WHERE workspace_id = ? AND granted_by = ?`,
			workspaceID, userID); err != nil {
			return fmt.Errorf("clear device connector bindings: %w", err)
		}
		now := formatTime(time.Now())
		for _, binding := range bindings {
			if err := tx.assertDeviceNotRemoved(ctx, binding.DeviceID); err != nil {
				return err
			}
			if _, err := tx.conn().ExecContext(ctx, `INSERT INTO device_connector_bindings
				(workspace_id, kind, device_id, members, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(workspace_id, kind, device_id) DO UPDATE SET
					members = excluded.members, granted_by = excluded.granted_by`,
				workspaceID, binding.Kind, binding.DeviceID, binding.Members, userID, now); err != nil {
				return fmt.Errorf("bind device connector: %w", err)
			}
		}
		return nil
	})
}

func (s *Store) ListWorkspaceDeviceConnectors(ctx context.Context, workspaceID string) ([]store.DeviceConnectorBinding, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT workspace_id, kind, device_id, members, granted_by, created_at
		FROM device_connector_bindings WHERE workspace_id = ? ORDER BY kind, created_at, device_id`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list workspace device connectors: %w", err)
	}
	defer rows.Close()
	bindings := []store.DeviceConnectorBinding{}
	for rows.Next() {
		var binding store.DeviceConnectorBinding
		if err := rows.Scan(&binding.WorkspaceID, &binding.Kind, &binding.DeviceID, &binding.Members,
			&binding.GrantedBy, &binding.CreatedAt); err != nil {
			return nil, err
		}
		bindings = append(bindings, binding)
	}
	return bindings, rows.Err()
}
