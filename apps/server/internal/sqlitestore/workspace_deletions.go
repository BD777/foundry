package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// recordWorkspaceDeletion remembers that the person deleted the workspace
// from its device, in the deleting transaction. A worker that still serves
// the folder (it missed the forget, or it reports the folder it was
// installed with on every start) would otherwise bring the workspace back.
func recordWorkspaceDeletion(ctx context.Context, exec dbExecutor, workspace store.WorkspaceProjection, at time.Time) error {
	if workspace.DeviceID == "" {
		return nil
	}
	_, err := exec.ExecContext(ctx, `INSERT INTO deleted_workspaces (workspace_id, device_id, local_path, deleted_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(workspace_id, device_id) DO UPDATE SET
			local_path = excluded.local_path,
			deleted_at = excluded.deleted_at`,
		workspace.ID, workspace.DeviceID, workspace.LocalPath, formatTime(at))
	if err != nil {
		return fmt.Errorf("record workspace deletion: %w", err)
	}
	return nil
}

// WorkspaceDeletedFromDevice reports whether the person deleted the
// workspace from the device and has not added its folder there again.
func (s *Store) WorkspaceDeletedFromDevice(ctx context.Context, workspaceID, deviceID string) (bool, error) {
	if workspaceID == "" || deviceID == "" {
		return false, nil
	}
	var found int
	err := s.conn().QueryRowContext(ctx,
		`SELECT 1 FROM deleted_workspaces WHERE workspace_id = ? AND device_id = ?`, workspaceID, deviceID).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read workspace deletion: %w", err)
	}
	return true, nil
}

// ClearWorkspaceDeletion takes back the deletion of the device's workspace
// at folder: the person is adding that folder again. The folder is compared
// as the worker records it (an absolute path, cleaned).
func (s *Store) ClearWorkspaceDeletion(ctx context.Context, deviceID, folder string) error {
	folder = strings.TrimSpace(folder)
	if deviceID == "" || folder == "" {
		return nil
	}
	if _, err := s.conn().ExecContext(ctx, `DELETE FROM deleted_workspaces WHERE device_id = ? AND local_path = ?`,
		deviceID, path.Clean(folder)); err != nil {
		return fmt.Errorf("clear workspace deletion: %w", err)
	}
	return nil
}
