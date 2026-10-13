package sqlitestore

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// SetDeviceServedWorkspaces marks each of the device's workspaces available
// when served lists it, WorkspaceFolderMissing when missing does (the worker
// still has it, its folder is gone) and WorkspaceNotServed otherwise.
// Nothing is deleted: sessions and history stay with the workspace.
func (s *Store) SetDeviceServedWorkspaces(ctx context.Context, deviceID string, served, missing []string) (bool, error) {
	reasons := make(map[string]string, len(served)+len(missing))
	for _, id := range missing {
		reasons[id] = store.WorkspaceFolderMissing
	}
	for _, id := range served {
		reasons[id] = ""
	}
	since := formatTime(time.Now().UTC())
	changed := false
	err := s.withTx(ctx, func(tx *Store) error {
		rows, err := tx.conn().QueryContext(ctx, `SELECT id, COALESCE(json_extract(payload_json, '$.unavailableOnDevice.reason'), '')
			FROM workspaces WHERE json_extract(payload_json, '$.deviceId') = ?`, deviceID)
		if err != nil {
			return fmt.Errorf("list device workspaces: %w", err)
		}
		type row struct {
			id     string
			reason string
		}
		var workspaces []row
		for rows.Next() {
			var item row
			if err := rows.Scan(&item.id, &item.reason); err != nil {
				rows.Close()
				return err
			}
			workspaces = append(workspaces, item)
		}
		if err := rows.Close(); err != nil {
			return err
		}
		for _, workspace := range workspaces {
			reason, listed := reasons[workspace.id]
			if !listed {
				reason = store.WorkspaceNotServed
			}
			if reason == workspace.reason {
				continue
			}
			query := `UPDATE workspaces SET payload_json = json_remove(payload_json, '$.unavailableOnDevice') WHERE id = ?`
			args := []any{workspace.id}
			if reason != "" {
				unavailable, err := json.Marshal(store.WorkspaceUnavailability{Reason: reason, Since: since})
				if err != nil {
					return err
				}
				query = `UPDATE workspaces SET payload_json = json_set(payload_json, '$.unavailableOnDevice', json(?)) WHERE id = ?`
				args = []any{string(unavailable), workspace.id}
			}
			if _, err := tx.conn().ExecContext(ctx, query, args...); err != nil {
				return fmt.Errorf("mark workspace availability: %w", err)
			}
			changed = true
		}
		return nil
	})
	return changed, err
}
