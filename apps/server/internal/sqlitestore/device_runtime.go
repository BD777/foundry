package sqlitestore

import (
	"context"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// SaveDeviceRuntimeState replaces the latest admission sample without
// recalculating it. Heartbeats call this independently of registrations.
func (s *Store) SaveDeviceRuntimeState(ctx context.Context, deviceID string, state store.DeviceRuntimeState) error {
	payload, err := encode(state)
	if err != nil {
		return err
	}
	result, err := s.conn().ExecContext(ctx, `UPDATE devices
		SET payload_json = json_set(payload_json, '$.runtimeState', json(?)),
			updated_at = ?
		WHERE id = ?`,
		payload, formatTime(time.Now().UTC()), deviceID)
	if err != nil {
		return fmt.Errorf("save device runtime state: %w", err)
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return store.ErrNotFound
	}
	return nil
}
