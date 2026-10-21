package sqlitestore

import (
	"context"
	"reflect"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Removal revokes grants but preserves configured locations. A home, role or
// Memory root is never silently moved; execution reauthorizes its device.
// This runs in the removal transaction and the idempotent startup repair.
func (s *Store) invalidateRemovedDeviceReferences(ctx context.Context, deviceID string) error {
	// Only authorization entries change. JSON updates preserve unknown fields
	// from newer settings versions and every explicitly configured location.
	_, err := s.conn().ExecContext(ctx, `UPDATE personal_agents
 SET settings_json = json_set(settings_json, '$.devices', json((
   SELECT json_group_array(json(value)) FROM json_each(settings_json, '$.devices')
   WHERE json_extract(value, '$.deviceId') != ?
 ))), updated_at = ?
 WHERE EXISTS (SELECT 1 FROM json_each(settings_json, '$.devices') WHERE json_extract(value, '$.deviceId') = ?)`, deviceID, paNow(), deviceID)
	return err
}

// Disabled stale grants can be submitted by an old form, but never become
// current authorization entries again. An enabled stale grant is rejected.
func (s *Store) currentPersonalAgentGrants(ctx context.Context, entries []store.PersonalAgentDeviceSettings) ([]store.PersonalAgentDeviceSettings, error) {
	result := make([]store.PersonalAgentDeviceSettings, 0, len(entries))
	for _, entry := range entries {
		removed, err := s.isDeviceRemoved(ctx, entry.DeviceID)
		if err != nil {
			return nil, err
		}
		if removed {
			if entry.AllowWork || entry.AllowCreate {
				return nil, store.ErrDeviceRemoved
			}
			continue
		}
		result = append(result, entry)
	}
	return result, nil
}

// Unchanged invalid locations remain visible and can be cleared while unrelated
// preferences are edited. New grants or changed removed targets are rejected.
func (s *Store) validatePersonalAgentDeviceReferences(ctx context.Context, previous, next store.PersonalAgentSettings) error {
	for _, entry := range next.Devices {
		if entry.AllowWork || entry.AllowCreate {
			if err := s.assertDeviceNotRemoved(ctx, entry.DeviceID); err != nil {
				return err
			}
		}
	}
	if next.PreferredDeviceID != previous.PreferredDeviceID {
		if err := s.assertDeviceNotRemoved(ctx, next.PreferredDeviceID); err != nil {
			return err
		}
	}
	check := func(old, preference *store.PersonalAgentRunPreference) error {
		if preference == nil || reflect.DeepEqual(old, preference) {
			return nil
		}
		if err := s.assertDeviceNotRemoved(ctx, preference.DeviceID); err != nil {
			return err
		}
		for _, fallback := range preference.Fallbacks {
			if err := s.assertDeviceNotRemoved(ctx, fallback.DeviceID); err != nil {
				return err
			}
			for _, workspace := range fallback.WorkspaceIDs {
				if err := s.assertWorkspaceDeviceNotRemoved(ctx, workspace); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := check(previous.RunDefault, next.RunDefault); err != nil {
		return err
	}
	for role, preference := range next.RoleOverrides {
		old := previous.RoleOverrides[role]
		if err := check(&old, &preference); err != nil {
			return err
		}
	}
	return nil
}
