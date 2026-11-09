package store

import (
	"context"
	"fmt"
)

// DeviceRemovalStore removes devices completely, leaving only a tombstone.
type DeviceRemovalStore interface {
	// RemoveDevice tombstones a device: it can never register or take work
	// again, and its credential is answered "device removed". Its data stays
	// until PurgeRemovedDevices deletes it.
	RemoveDevice(ctx context.Context, input RemoveDeviceInput) (DeviceProjection, error)
	// DeviceRemovalPreview reports what removing the device would delete.
	DeviceRemovalPreview(ctx context.Context, deviceID string) (DeviceRemovalPreview, error)
	// RunningDeviceTurns counts the turns that would make removing a connected
	// device wait for confirmation.
	RunningDeviceTurns(ctx context.Context, deviceID string) (int, error)
	// PurgeRemovedDevices deletes everything the removed devices still own:
	// their workspaces with all they hold, their sessions, work and
	// settings. Idempotent; it writes in short steps beside requests.
	PurgeRemovedDevices(ctx context.Context) error
	// RemovedDeviceCredential reports whether credentialHash was the
	// credential of a removed device.
	RemovedDeviceCredential(ctx context.Context, credentialHash string) (bool, error)
}

// RemoveDeviceInput asks to remove a device and everything it owned.
type RemoveDeviceInput struct {
	ID string
	// Connected: the device's worker holds a live connection now. An
	// offline device is always removable; what it left running is deleted
	// with it.
	Connected bool
	// StopRunningTurns is the person's confirmation that the turns running
	// on a connected device end with it.
	StopRunningTurns bool
}

// DeviceRemovalPreview is what removing a device would delete. Workspaces,
// sessions and issues are named apart for the removal dialog; Other counts
// every remaining table that would lose rows.
type DeviceRemovalPreview struct {
	Workspaces []DeviceRemovalWorkspace `json:"workspaces"`
	Sessions   int                      `json:"sessions"`
	Issues     int                      `json:"issues"`
	Other      map[string]int           `json:"other"`
}

// DeviceRemovalWorkspace identifies one workspace that removal would delete.
type DeviceRemovalWorkspace struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// DeviceTurnsRunningError refuses removing a connected device while turns
// run on it, until the person confirms (RemoveDeviceInput.StopRunningTurns).
type DeviceTurnsRunningError struct {
	Turns int
}

func (e *DeviceTurnsRunningError) Error() string {
	return fmt.Sprintf("%d turn(s) are running on this device; removing it stops them", e.Turns)
}

func (e *DeviceTurnsRunningError) Is(target error) bool { return target == ErrDeviceBusy }

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
