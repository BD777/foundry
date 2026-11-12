package httpapi

import (
	"context"
	"errors"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/resources"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// deviceReconnectGrace is how long a dropped device may reconnect before it
// counts as offline. Tests shorten it.
var deviceReconnectGrace = 60 * time.Second

// deviceReconnectWait bounds how long an operation waits for a device in its
// reconnect grace. Tests shorten it.
var deviceReconnectWait = 30 * time.Second

const (
	deviceStatusReconnecting   = "reconnecting"
	deviceStatusDisconnected   = "disconnected"
	deviceStatusLabelOnline    = "online"
	deviceStatusLabelOffline   = "offline"
	deviceStatusLabelReconnect = "reconnecting"
)

// deviceReconnect is one grace window. registrations are the last complete
// reports of the connection that ended; expiry writes them offline just as
// unregister used to do immediately.
type deviceReconnect struct {
	since         time.Time
	until         time.Time
	registrations []store.DaemonRegistration
	deviceOnly    bool
	done          chan struct{}
	doneOnce      sync.Once
	changed       chan struct{}
	changedOnce   sync.Once
	resuming      bool
}

// startDeviceReconnect records the reconnecting state, gives it a grace
// window, and publishes the state once the new connection did not win a race
// with the update.
func (h *DaemonHub) startDeviceReconnect(deviceID string, registrations []store.DaemonRegistration, deviceOnly bool) {
	for _, registration := range registrations {
		registration.Device.Status = deviceStatusReconnecting
		registration.Device.LastSeenLabel = deviceStatusLabelReconnect
		if _, err := h.registerDaemon(context.Background(), registration); err != nil && !errors.Is(err, store.ErrDeviceRemoved) {
			log.Printf("daemon websocket reconnect update failed for %s: %v", deviceID, err)
		}
	}
	if !h.scheduleDeviceReconnect(deviceID, registrations, deviceOnly, time.Now().UTC()) {
		return
	}
	if len(registrations) == 0 || deviceOnly {
		// Its disconnect news is also visible as device data, and no device
		// event reaches a workspace-less device's viewers.
		h.dataChanges.changed("", fieldDevices)
	}
	for _, registration := range registrations {
		h.devices.registrationChanged(registration)
	}
}

// scheduleDeviceReconnect installs one tracked timer. A connection that
// arrives first wins and leaves the stored status connected.
func (h *DaemonHub) scheduleDeviceReconnect(deviceID string, registrations []store.DaemonRegistration, deviceOnly bool, since time.Time) bool {
	h.mu.Lock()
	if h.shuttingDown {
		h.mu.Unlock()
		return false
	}
	if h.connections[deviceID] != nil {
		h.mu.Unlock()
		h.ensureDeviceConnected(deviceID)
		return false
	}
	if previous := h.reconnects[deviceID]; previous != nil {
		previous.stop()
		previous.notify()
	}
	reconnect := &deviceReconnect{
		since:         since,
		until:         since.Add(deviceReconnectGrace),
		registrations: registrations,
		deviceOnly:    deviceOnly,
		done:          make(chan struct{}),
		changed:       make(chan struct{}),
	}
	h.reconnects[deviceID] = reconnect
	h.mu.Unlock()

	if !h.work.Go(func() {
		timer := time.NewTimer(time.Until(reconnect.until))
		defer timer.Stop()
		select {
		case <-h.work.ctx.Done():
			return
		case <-reconnect.done:
			return
		case <-timer.C:
			h.expireDeviceReconnect(deviceID, reconnect)
		}
	}) {
		h.forgetDeviceReconnect(deviceID, reconnect)
		return false
	}
	return true
}

func (h *DaemonHub) expireDeviceReconnect(deviceID string, reconnect *deviceReconnect) {
	h.mu.Lock()
	if h.reconnects[deviceID] != reconnect || h.connections[deviceID] != nil || h.shuttingDown || reconnect.resuming {
		h.mu.Unlock()
		return
	}
	delete(h.reconnects, deviceID)
	reconnect.notify()
	h.mu.Unlock()

	h.deviceOffline(deviceID, reconnect.registrations, reconnect.deviceOnly)
}

func (h *DaemonHub) forgetDeviceReconnect(deviceID string, reconnect *deviceReconnect) {
	h.mu.Lock()
	if h.reconnects[deviceID] == reconnect {
		delete(h.reconnects, deviceID)
		reconnect.notify()
	}
	h.mu.Unlock()
}

func (reconnect *deviceReconnect) stop() {
	reconnect.doneOnce.Do(func() { close(reconnect.done) })
}

func (reconnect *deviceReconnect) notify() {
	reconnect.changedOnce.Do(func() { close(reconnect.changed) })
}

// connectionEstablished closes a reconnect window after a new socket became
// the device's live connection. The registration already stored connected;
// the targeted write also repairs a disconnect update that raced it.
func (h *DaemonHub) connectionEstablished(deviceID string) {
	h.mu.Lock()
	reconnect := h.reconnects[deviceID]
	if reconnect != nil {
		reconnect.stop()
		reconnect.notify()
		delete(h.reconnects, deviceID)
	}
	h.mu.Unlock()
	if reconnect != nil {
		h.ensureDeviceConnected(deviceID)
	}
}

// waitForConnection returns the device's live connection, waits while it is
// reconnecting, and refuses immediately when it is offline. The wait is
// bounded by deviceReconnectWait and ends with the request's context.
func (h *DaemonHub) waitForConnection(ctx context.Context, deviceID string) (*daemonConnection, error) {
	timer := time.NewTimer(deviceReconnectWait)
	defer timer.Stop()

	for {
		h.mu.Lock()
		connection := h.connections[deviceID]
		reconnect := h.reconnects[deviceID]
		h.mu.Unlock()

		if connectionLive(connection) {
			return connection, nil
		}
		if reconnect == nil {
			return nil, sessions.ErrLocalDaemonNotConnected
		}
		select {
		case <-reconnect.changed:
			// Re-check the connection and current reconnect window.
		case <-timer.C:
			if h.HasConnection(deviceID) {
				return h.connectionFor(deviceID), nil
			}
			return nil, &resources.DeviceReconnectingError{Device: h.deviceName(context.WithoutCancel(ctx), deviceID)}
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

func connectionLive(connection *daemonConnection) bool {
	if connection == nil {
		return false
	}
	select {
	case <-connection.done:
		return false
	default:
		return true
	}
}

func (h *DaemonHub) deviceName(ctx context.Context, deviceID string) string {
	devices, err := h.store.ListDevices(ctx)
	if err == nil {
		for _, device := range devices {
			if device.ID == deviceID {
				if label := strings.TrimSpace(device.Label); label != "" {
					return label
				}
				break
			}
		}
	}
	if deviceID = strings.TrimSpace(deviceID); deviceID != "" {
		return deviceID
	}
	return "The device"
}

// connectionResuming stops the offline deadline as soon as a new
// registration is stored. The reconnect entry stays visible until the socket
// is published, so listing never briefly calls the reconnecting device
// offline.
func (h *DaemonHub) connectionResuming(deviceID string) {
	h.mu.Lock()
	if reconnect := h.reconnects[deviceID]; reconnect != nil {
		reconnect.resuming = true
		reconnect.stop()
	}
	h.mu.Unlock()
}

func (h *DaemonHub) ensureDeviceConnected(deviceID string) {
	if err := h.store.SetDeviceStatus(context.Background(), deviceID, deviceStatusConnected, deviceStatusLabelOnline); err != nil &&
		!errors.Is(err, store.ErrDeviceRemoved) && !errors.Is(err, store.ErrNotFound) {
		log.Printf("daemon %s: connected status repair failed: %v", deviceID, err)
	}
}

// resumeDeviceReconnects gives devices recorded online by the previous
// process the same grace after this process starts.
func (h *DaemonHub) resumeDeviceReconnects(ctx context.Context) {
	devices, err := h.store.ListDevices(ctx)
	if err != nil {
		log.Printf("devices: reconnect grace not started: %v", err)
		return
	}
	now := time.Now().UTC()
	for _, device := range devices {
		if device.Status != deviceStatusConnected && device.Status != deviceStatusReconnecting {
			continue
		}
		if device.Status == deviceStatusConnected {
			if err := h.store.SetDeviceStatus(ctx, device.ID, deviceStatusReconnecting, deviceStatusLabelReconnect); err != nil &&
				!errors.Is(err, store.ErrDeviceRemoved) && !errors.Is(err, store.ErrNotFound) {
				log.Printf("daemon %s: reconnect state not stored: %v", device.ID, err)
			}
		}
		h.scheduleDeviceReconnect(device.ID, nil, false, now)
	}
}

// deviceConnection is the connection view resources and list_resources use.
// online is true only while the daemon socket is live.
func (h *DaemonHub) deviceConnection(deviceID string) resources.Connection {
	h.mu.Lock()
	connection := h.connections[deviceID]
	reconnect := h.reconnects[deviceID]
	h.mu.Unlock()

	if connection != nil {
		select {
		case <-connection.done:
		default:
			return resources.Connection{State: resources.ConnectionOnline}
		}
	}
	if reconnect != nil {
		return resources.Connection{
			State:          resources.ConnectionReconnecting,
			DisconnectedAt: reconnect.since,
			ReconnectAt:    reconnect.until,
		}
	}
	return resources.Connection{State: resources.ConnectionOffline}
}

// deviceOffline is the action unregister used to take immediately. It now
// runs only after the grace window ends without a connection.
func (h *DaemonHub) deviceOffline(deviceID string, registrations []store.DaemonRegistration, deviceOnly bool) {
	h.resourcesOffline(deviceID)
	if len(registrations) == 0 {
		if err := h.store.SetDeviceStatus(context.Background(), deviceID, deviceStatusDisconnected, deviceStatusLabelOffline); err != nil &&
			!errors.Is(err, store.ErrDeviceRemoved) && !errors.Is(err, store.ErrNotFound) {
			log.Printf("daemon %s: offline status not stored: %v", deviceID, err)
		}
		if !h.devices.changed(context.Background(), deviceID) {
			h.dataChanges.changed("", fieldDevices)
		}
		return
	}
	if deviceOnly {
		// Its disconnect record (lastDisconnect) is news too, and no device
		// event reaches a workspace-less device's viewers.
		h.dataChanges.changed("", fieldDevices)
	}
	for _, registration := range registrations {
		registration.Device.Status = deviceStatusDisconnected
		registration.Device.LastSeenLabel = deviceStatusLabelOffline
		if _, err := h.registerDaemon(context.Background(), registration); err == nil {
			h.devices.registrationChanged(registration)
		} else if !errors.Is(err, store.ErrDeviceRemoved) {
			log.Printf("daemon websocket offline update failed for %s: %v", deviceID, err)
		}
	}
}
