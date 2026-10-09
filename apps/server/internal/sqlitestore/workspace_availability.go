package sqlitestore

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// SetDeviceServedWorkspaces marks each of the device's workspaces available
// when served lists it and unavailable on the device otherwise. Nothing is
// deleted: sessions and history stay with the workspace.
func (s *Store) SetDeviceServedWorkspaces(ctx context.Context, deviceID string, served []string) (bool, error) {
	servedSet := make(map[string]bool, len(served))
	for _, id := range served {
		servedSet[id] = true
	}
	unavailable, err := json.Marshal(store.WorkspaceUnavailability{
		Reason: store.WorkspaceNotServed,
		Since:  formatTime(time.Now().UTC()),
	})
	if err != nil {
		return false, err
	}
	changed := false
	err = s.withTx(ctx, func(tx *Store) error {
		rows, err := tx.conn().QueryContext(ctx, `SELECT id, json_extract(payload_json, '$.unavailableOnDevice') IS NOT NULL
			FROM workspaces WHERE json_extract(payload_json, '$.deviceId') = ?`, deviceID)
		if err != nil {
			return fmt.Errorf("list device workspaces: %w", err)
		}
		type row struct {
			id     string
			marked bool
		}
		var workspaces []row
		for rows.Next() {
			var item row
			if err := rows.Scan(&item.id, &item.marked); err != nil {
				rows.Close()
				return err
			}
			workspaces = append(workspaces, item)
		}
		if err := rows.Close(); err != nil {
			return err
		}
		for _, workspace := range workspaces {
			mark := !servedSet[workspace.id]
			if mark == workspace.marked {
				continue
			}
			query := `UPDATE workspaces SET payload_json = json_remove(payload_json, '$.unavailableOnDevice') WHERE id = ?`
			args := []any{workspace.id}
			if mark {
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
