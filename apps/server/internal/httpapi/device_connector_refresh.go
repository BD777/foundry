package httpapi

import (
	"context"
	"sync"
	"time"
)

// deviceConnectorRefreshEvery is how often a device that connects again
// with the same Worker has its device-held connectors read again.
const deviceConnectorRefreshEvery = 30 * time.Minute

// deviceConnectorRefreshes remembers, per device, the Worker version and
// time of the last refresh this server made.
type deviceConnectorRefreshes struct {
	mu   sync.Mutex
	last map[string]deviceConnectorRefresh
}

type deviceConnectorRefresh struct {
	version string
	at      time.Time
}

// due reports whether a device connecting with workerVersion should have
// its connectors read now, and if so records the refresh.
func (r *deviceConnectorRefreshes) due(deviceID, workerVersion string, now time.Time) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.last == nil {
		r.last = map[string]deviceConnectorRefresh{}
	}
	previous, seen := r.last[deviceID]
	if seen && previous.version == workerVersion && now.Sub(previous.at) < deviceConnectorRefreshEvery {
		return false
	}
	r.last[deviceID] = deviceConnectorRefresh{version: workerVersion, at: now}
	return true
}

// refreshDeviceConnectorsOnConnect reads again, on a device that just
// connected, the device-held connectors it has a stored reading of, so what
// its previous Worker reported (a session check's isolation warning, a
// signed-in state) does not stay until the owner checks again. A new Worker
// version reads at once; the same version at most every
// deviceConnectorRefreshEvery. Connectors are read one after another;
// a failure is logged and leaves the stored reading as it was.
func (s *Server) refreshDeviceConnectorsOnConnect(ctx context.Context, deviceID string) {
	if s.connectors == nil || s.connectors.Devices == nil {
		return
	}
	states, err := s.connectors.Devices.States(ctx, []string{deviceID})
	if err != nil || len(states) == 0 {
		return
	}
	workerVersion := ""
	if devices, err := s.store.ListDevices(ctx); err == nil {
		for _, device := range devices {
			if device.ID == deviceID && device.Worker != nil {
				workerVersion = device.Worker.Version
			}
		}
	}
	if !s.connectorsOnConnect.due(deviceID, workerVersion, time.Now()) {
		return
	}
	for _, state := range states {
		if ctx.Err() != nil {
			return
		}
		descriptor, err := s.connectors.Devices.ConnectorOn(ctx, deviceID, state.Kind)
		if err != nil {
			continue
		}
		// Joins a read the Connectors page started, and shows as checking there.
		<-s.connectorRefreshes.start(deviceID, descriptor.Kind, func() {
			readCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), connectorRefreshTimeout)
			defer cancel()
			if _, err := s.readDeviceConnector(readCtx, deviceID, descriptor, true); err != nil {
				s.connectors.ServerHeld.Logf("connector refresh on connect device=%s kind=%s failed: %v", deviceID, descriptor.Kind, err)
			}
		})
	}
}
