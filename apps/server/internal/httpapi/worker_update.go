package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// workerUpdateCapability is declared by workers that update themselves on
// request; older ones are updated by running a command on the device.
const workerUpdateCapability = "worker_update"

// workerUpdateWindow bounds how long an update counts as in progress; a
// worker that has not come back with the new version by then failed.
const workerUpdateWindow = 15 * time.Minute

// workerUpdates remembers updates requested from Foundry until the device
// reports the version they bring, so every page shows them and a second
// request is refused.
type workerUpdates struct {
	mu      sync.Mutex
	pending map[string]store.DeviceWorkerUpdate
}

// active is the update in progress on a device running workerVersion.
func (u *workerUpdates) active(deviceID string, workerVersion string, now time.Time) (store.DeviceWorkerUpdate, bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	update, ok := u.pending[deviceID]
	if !ok {
		return store.DeviceWorkerUpdate{}, false
	}
	started, _ := time.Parse(time.RFC3339, update.StartedAt)
	if now.Sub(started) >= workerUpdateWindow || (update.Version != "" && workerVersion == update.Version) {
		delete(u.pending, deviceID)
		return store.DeviceWorkerUpdate{}, false
	}
	return update, true
}

func (u *workerUpdates) start(deviceID string, update store.DeviceWorkerUpdate) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.pending == nil {
		u.pending = map[string]store.DeviceWorkerUpdate{}
	}
	u.pending[deviceID] = update
}

func (u *workerUpdates) cancel(deviceID string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	delete(u.pending, deviceID)
}

// withWorkerUpdates marks devices whose requested update is still running.
func (s *Server) withWorkerUpdates(devices []store.DeviceProjection) []store.DeviceProjection {
	now := time.Now().UTC()
	for i := range devices {
		version := ""
		if devices[i].Worker != nil {
			version = devices[i].Worker.Version
		}
		if update, ok := s.workerUpdates.active(devices[i].ID, version, now); ok {
			update := update
			devices[i].WorkerUpdate = &update
		}
	}
	return devices
}

type wsWorkerUpdateStarted struct {
	// Log is the file on the device the update writes to.
	Log   string `json:"log,omitempty"`
	Error string `json:"error,omitempty"`
}

// errWorkerUpdateRefused is a reason an update cannot start now, meant for
// the person who asked.
type errWorkerUpdateRefused struct{ reason string }

func (e errWorkerUpdateRefused) Error() string { return e.reason }

// startWorkerUpdate asks a device's worker to update itself to the version
// this server names. The worker answers once the update has started; it then
// restarts and reconnects with the new version.
func (s *Server) startWorkerUpdate(ctx context.Context, deviceID string) (wsWorkerUpdateStarted, error) {
	offline := errWorkerUpdateRefused{"The device is offline; update it once it reconnects."}
	connection := s.hub.connectionFor(deviceID)
	if connection == nil {
		return wsWorkerUpdateStarted{}, offline
	}
	worker := ""
	if _, registration := connection.registrationSnapshot(); registration.Device.Worker != nil {
		worker = registration.Device.Worker.Version
	}
	if update, ok := s.workerUpdates.active(deviceID, worker, time.Now().UTC()); ok {
		return wsWorkerUpdateStarted{}, errWorkerUpdateRefused{"An update is already running on this device (started " + update.StartedAt + ")."}
	}
	if !connection.hasCapability(workerUpdateCapability) {
		return wsWorkerUpdateStarted{}, errWorkerUpdateRefused{"This worker is too old to update itself; run the update command on the device once."}
	}
	target := ""
	if manifest, err := s.readWorkerRelease(); err == nil && manifest != nil {
		target = manifest.Version
	}
	// Recorded before asking, so a second request while this one is on its
	// way is refused too.
	s.workerUpdates.start(deviceID, store.DeviceWorkerUpdate{StartedAt: time.Now().UTC().Format(time.RFC3339), Version: target})
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	value, err := daemonRequest[wsWorkerUpdateStarted](ctx, connection, wsUpdateWorkerType, []byte("{}"))
	if err != nil || value.Error != "" {
		s.workerUpdates.cancel(deviceID)
	}
	if err == nil && value.Error != "" {
		err = errWorkerUpdateRefused{value.Error}
	}
	if errors.Is(err, store.ErrNotFound) {
		return wsWorkerUpdateStarted{}, offline
	}
	if err != nil {
		return wsWorkerUpdateStarted{}, err
	}
	s.invalidateProjections()
	// Once the window passes, projections stop showing the update.
	time.AfterFunc(workerUpdateWindow, s.invalidateProjections)
	return value, nil
}

func (s *Server) handleUpdateWorker(w http.ResponseWriter, r *http.Request) {
	value, err := s.startWorkerUpdate(r.Context(), strings.TrimSpace(r.PathValue("deviceId")))
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, value)
}
