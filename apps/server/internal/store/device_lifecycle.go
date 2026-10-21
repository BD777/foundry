package store

import "context"

// DeviceCatalog separates historical identity from candidates for new work.
// ListDevices includes removed identities so old work remains attributable.
// A candidate can be offline; connectivity is a separate execution policy.
type DeviceCatalog interface {
	ListDevices(context.Context) ([]DeviceProjection, error)
}

func DeviceAvailable(device DeviceProjection) bool {
	return device.ID != "" && device.Status != "removed"
}

func DeviceCandidates(ctx context.Context, catalog DeviceCatalog) ([]DeviceProjection, error) {
	devices, err := catalog.ListDevices(ctx)
	if err != nil {
		return nil, err
	}
	candidates := make([]DeviceProjection, 0, len(devices))
	for _, device := range devices {
		if DeviceAvailable(device) {
			candidates = append(candidates, device)
		}
	}
	return candidates, nil
}

// AvailableOwnedDevices is a placement query, not a historical ownership query.
func AvailableOwnedDevices(ctx context.Context, catalog interface {
	DevicesOwnedBy(context.Context, string) ([]string, error)
	DeviceRemoved(context.Context, string) (bool, error)
}, userID string) ([]string, error) {
	owned, err := catalog.DevicesOwnedBy(ctx, userID)
	if err != nil {
		return nil, err
	}
	// Pairing creates the identity before its first inventory. Missing display
	// metadata does not mean removal; only the lifecycle tombstone revokes it.
	result := make([]string, 0, len(owned))
	for _, id := range owned {
		removed, err := catalog.DeviceRemoved(ctx, id)
		if err != nil {
			return nil, err
		}
		if !removed {
			result = append(result, id)
		}
	}
	return result, nil
}

// RequireDeviceAvailable is a read-time check. Store mutations must repeat the
// tombstone check inside their write transaction to fence concurrent removal.
func RequireDeviceAvailable(ctx context.Context, lifecycle interface {
	DeviceRemoved(context.Context, string) (bool, error)
}, id string) error {
	removed, err := lifecycle.DeviceRemoved(ctx, id)
	if err != nil {
		return err
	}
	if removed {
		return ErrDeviceRemoved
	}
	return nil
}
