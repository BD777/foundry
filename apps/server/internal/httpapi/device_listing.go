package httpapi

import (
	"context"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// liveDevices adds to devices as stored what only this server process knows
// of them: each one's last drop and its worker update in progress.
func (s *Server) liveDevices(devices []store.DeviceProjection) []store.DeviceProjection {
	return s.hub.withDisconnects(s.withDeviceRunners(s.withWorkerUpdates(devices)))
}

// deviceForEvent is the device as foundry-data lists it to a viewer who does
// not own it: a device event reaches every viewer of the device's workspace,
// so what only its owner sees (runtimeSettings, sharesSystemAccountWith)
// and what depends on the viewer (owned) stay out.
func (s *Server) deviceForEvent(ctx context.Context, deviceID string) (store.DeviceProjection, bool) {
	devices, err := s.store.ListDevices(ctx)
	if err != nil {
		return store.DeviceProjection{}, false
	}
	for _, device := range devices {
		if device.ID != deviceID {
			continue
		}
		listed := s.liveDevices([]store.DeviceProjection{device})[0]
		listed.RuntimeSettings = nil
		listed.Owned = false
		listed.SharesSystemAccountWith = nil
		return listed, true
	}
	return store.DeviceProjection{}, false
}
