package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// setupOwnership adds the ownership model: workspace memberships (the device
// owner is always a workspace owner), the workspace's device as a real
// column, and connection owners. Resources that predate accounts go to the
// earliest admin, or to the first admin once one is created.
func (s *Store) setupOwnership(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS workspace_members (
			workspace_id TEXT NOT NULL,
			user_id TEXT NOT NULL REFERENCES users(id),
			role TEXT NOT NULL CHECK (role IN ('owner', 'maintainer', 'member', 'viewer')),
			added_by TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (workspace_id, user_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members (user_id)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite ownership: %w", err)
		}
	}
	if err := s.ensureColumn(ctx, "workspaces", "device_id",
		`ALTER TABLE workspaces ADD COLUMN device_id TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if _, err := s.conn().ExecContext(ctx, `UPDATE workspaces
		SET device_id = COALESCE(json_extract(payload_json, '$.deviceId'), '')
		WHERE device_id = ''`); err != nil {
		return fmt.Errorf("backfill workspace devices: %w", err)
	}
	if _, err := s.conn().ExecContext(ctx,
		`CREATE INDEX IF NOT EXISTS idx_workspaces_device ON workspaces (device_id)`); err != nil {
		return fmt.Errorf("index workspace devices: %w", err)
	}
	admin, err := s.earliestAdmin(ctx)
	if err != nil || admin == "" {
		return err
	}
	return s.assignUnownedResources(ctx, admin)
}

func (s *Store) earliestAdmin(ctx context.Context) (string, error) {
	var id string
	err := s.conn().QueryRowContext(ctx, `SELECT id FROM users
		WHERE role = ? AND disabled_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1`, store.RoleAdmin).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("find earliest admin: %w", err)
	}
	return id, nil
}

// assignUnownedResources gives every workspace without members and every
// connection without an owner to userID.
func (s *Store) assignUnownedResources(ctx context.Context, userID string) error {
	now := formatTime(time.Now().UTC())
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO workspace_members
		(workspace_id, user_id, role, added_by, created_at)
		SELECT w.id, ?, 'owner', 'migration', ? FROM workspaces AS w
		WHERE NOT EXISTS (SELECT 1 FROM workspace_members AS m WHERE m.workspace_id = w.id)`,
		userID, now); err != nil {
		return fmt.Errorf("assign unowned workspaces: %w", err)
	}
	if _, err := s.conn().ExecContext(ctx,
		`UPDATE profiles SET owner_user_id = ? WHERE owner_user_id = ''`, userID); err != nil {
		return fmt.Errorf("assign unowned connections: %w", err)
	}
	return nil
}

// ensureDeviceOwnerMembership keeps the device owner an owner of every
// workspace registered on the device. Devices without an identity (paired
// before device credentials) are left to the migration owner.
func (s *Store) ensureDeviceOwnerMembership(ctx context.Context, workspaceID, deviceID string) error {
	var owner string
	err := s.conn().QueryRowContext(ctx,
		`SELECT owner_user_id FROM device_identities WHERE device_id = ?`, deviceID).Scan(&owner)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("find device owner: %w", err)
	}
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO workspace_members
		(workspace_id, user_id, role, added_by, created_at) VALUES (?, ?, 'owner', 'device', ?)
		ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = 'owner'`,
		workspaceID, owner, formatTime(time.Now().UTC())); err != nil {
		return fmt.Errorf("record workspace owner: %w", err)
	}
	return nil
}

func (s *Store) ListWorkspaceMembers(ctx context.Context, workspaceID string) ([]store.WorkspaceMember, error) {
	rows, err := s.conn().QueryContext(ctx, `SELECT workspace_id, user_id, role, added_by, created_at
		FROM workspace_members WHERE workspace_id = ? ORDER BY created_at ASC, user_id ASC`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list workspace members: %w", err)
	}
	defer rows.Close()
	members := []store.WorkspaceMember{}
	for rows.Next() {
		var member store.WorkspaceMember
		var createdAt string
		if err := rows.Scan(&member.WorkspaceID, &member.UserID, &member.Role, &member.AddedBy, &createdAt); err != nil {
			return nil, fmt.Errorf("scan workspace member: %w", err)
		}
		member.CreatedAt = parseStoredTime(createdAt)
		members = append(members, member)
	}
	return members, rows.Err()
}

var _ store.OwnershipStore = (*Store)(nil)

func (s *Store) WorkspaceRolesForUser(ctx context.Context, userID string) (map[string]string, error) {
	rows, err := s.conn().QueryContext(ctx,
		`SELECT workspace_id, role FROM workspace_members WHERE user_id = ?`, userID)
	if err != nil {
		return nil, fmt.Errorf("list workspace roles: %w", err)
	}
	defer rows.Close()
	roles := map[string]string{}
	for rows.Next() {
		var workspaceID, role string
		if err := rows.Scan(&workspaceID, &role); err != nil {
			return nil, fmt.Errorf("scan workspace role: %w", err)
		}
		roles[workspaceID] = role
	}
	return roles, rows.Err()
}

func (s *Store) DevicesOwnedBy(ctx context.Context, userID string) ([]string, error) {
	rows, err := s.conn().QueryContext(ctx,
		`SELECT device_id FROM device_identities WHERE owner_user_id = ?`, userID)
	if err != nil {
		return nil, fmt.Errorf("list owned devices: %w", err)
	}
	defer rows.Close()
	devices := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan owned device: %w", err)
		}
		devices = append(devices, id)
	}
	return devices, rows.Err()
}

func (s *Store) RunWorkspace(ctx context.Context, runID string) (string, error) {
	var workspaceID string
	err := s.conn().QueryRowContext(ctx, `SELECT workspace_id FROM runs WHERE id = ?`, runID).Scan(&workspaceID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", store.ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("find run workspace: %w", err)
	}
	return workspaceID, nil
}

func (s *Store) RemoveWorkspaceMember(ctx context.Context, workspaceID, userID string) error {
	result, err := s.conn().ExecContext(ctx,
		`DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?`, workspaceID, userID)
	if err != nil {
		return fmt.Errorf("remove workspace member: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (s *Store) SetWorkspaceMember(ctx context.Context, workspaceID, userID, role, addedBy string) error {
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO workspace_members
		(workspace_id, user_id, role, added_by, created_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`,
		workspaceID, userID, role, addedBy, formatTime(time.Now().UTC())); err != nil {
		return fmt.Errorf("set workspace member: %w", err)
	}
	return nil
}
