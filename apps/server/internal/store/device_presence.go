package store

import "context"

type DevicePresenceStore interface {
	// SetDeviceStatus updates only the device's presence fields. Startup and
	// delayed disconnect handling use it without replacing what else the
	// device last reported.
	SetDeviceStatus(ctx context.Context, id string, status string, lastSeenLabel string) error
}
