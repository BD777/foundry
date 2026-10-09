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

// workerUpdateStatusCapability is declared by workers that answer status
// probes while they update; the server then learns of a failure in seconds,
// and older workers are left to workerUpdateWindow.
const workerUpdateStatusCapability = "worker_update_status"

// workerUpdateWindow is how long an update may take; one still on its old
// version after that is shown as not finished.
const workerUpdateWindow = 15 * time.Minute

const (
	// workerUpdateProbeInterval is how often a probing worker is asked.
	workerUpdateProbeInterval = 10 * time.Second
	// workerUpdateReturnGrace is how long a worker may stay away while it
	// restarts before the update counts as failed.
	workerUpdateReturnGrace = 2 * time.Minute
)

const (
	workerUpdateFailedExited   = "exited"
	workerUpdateFailedVanished = "vanished"
	workerUpdateFailedNotBack  = "not_back"
)

// workerUpdates remembers updates requested from Foundry until the device
// comes back on another version, so every page shows them, a second request
// is refused while one runs, and one that never finished stays visible.
type workerUpdates struct {
	mu      sync.Mutex
	pending map[string]store.DeviceWorkerUpdate
	// probeInterval and returnGrace override the defaults in tests.
	probeInterval time.Duration
	returnGrace   time.Duration
}

func (u *workerUpdates) timing() (probe time.Duration, grace time.Duration) {
	u.mu.Lock()
	defer u.mu.Unlock()
	probe, grace = u.probeInterval, u.returnGrace
	if probe <= 0 {
		probe = workerUpdateProbeInterval
	}
	if grace <= 0 {
		grace = workerUpdateReturnGrace
	}
	return probe, grace
}

// active is the update recorded for a device now running workerVersion. It
// ends when the device runs another version than it did at the start; past
// the window it is reported as stalled instead of dropped.
func (u *workerUpdates) active(deviceID string, workerVersion string, now time.Time) (store.DeviceWorkerUpdate, bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	update, ok := u.pending[deviceID]
	if !ok {
		return store.DeviceWorkerUpdate{}, false
	}
	if workerVersion != "" && (workerVersion == update.Version || (update.FromVersion != "" && workerVersion != update.FromVersion)) {
		delete(u.pending, deviceID)
		return store.DeviceWorkerUpdate{}, false
	}
	started, _ := time.Parse(time.RFC3339, update.StartedAt)
	update.Stalled = update.Failure == "" && now.Sub(started) >= workerUpdateWindow
	return update, true
}

// wsWorkerUpdateStatus is a worker's answer to read_worker_update_status,
// also sent unasked when its update fails.
type wsWorkerUpdateStatus struct {
	// State is running, failed, succeeded or none (no update runs and none
	// left an outcome: it ended without a word).
	State     string   `json:"state"`
	StartedAt string   `json:"startedAt,omitempty"`
	Step      string   `json:"step,omitempty"`
	Version   string   `json:"version,omitempty"`
	Detail    string   `json:"detail,omitempty"`
	ElapsedMs int64    `json:"elapsedMs,omitempty"`
	ExitCode  *int     `json:"exitCode,omitempty"`
	Error     string   `json:"error,omitempty"`
	LogTail   []string `json:"logTail,omitempty"`
}

// apply records what a worker said about the device's update started at
// startedAt (any unfinished one when empty). It reports whether the update
// changed and whether it is over as far as probing goes.
func (u *workerUpdates) apply(deviceID, startedAt string, status wsWorkerUpdateStatus) (changed bool, settled bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	update, ok := u.pending[deviceID]
	if !ok || update.Failure != "" || (startedAt != "" && update.StartedAt != startedAt) {
		return false, true
	}
	before := update.Step + "\x00" + update.StepDetail
	if status.Step != "" {
		update.Step = status.Step
	}
	if update.Version == "" {
		update.Version = status.Version
	}
	switch status.State {
	case "running":
		update.StepDetail = status.Detail
	case "succeeded":
		// The worker restarts on the new version; until it is back the
		// update is restarting.
		update.Step, update.StepDetail = "restarting", ""
	case "failed":
		update.StepDetail = ""
		update.Failure = strings.TrimSpace(status.Error)
		if update.Failure == "" {
			update.Failure = "the update failed"
		}
		update.FailureCode = workerUpdateFailedExited
		update.ExitCode = status.ExitCode
		update.LogTail = status.LogTail
	case "none":
		update.StepDetail = ""
		update.Failure = "the update process ended without reporting"
		update.FailureCode = workerUpdateFailedVanished
		update.LogTail = status.LogTail
	default:
		return false, false
	}
	u.pending[deviceID] = update
	return update.Failure != "" || before != update.Step+"\x00"+update.StepDetail, update.Failure != ""
}

// fail ends the device's update started at startedAt as failed.
func (u *workerUpdates) fail(deviceID, startedAt, code, reason string) bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	update, ok := u.pending[deviceID]
	if !ok || update.Failure != "" || update.StartedAt != startedAt {
		return false
	}
	update.Failure, update.FailureCode, update.StepDetail = reason, code, ""
	u.pending[deviceID] = update
	return true
}

func (u *workerUpdates) setLog(deviceID, log string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if update, ok := u.pending[deviceID]; ok {
		update.Log = log
		u.pending[deviceID] = update
	}
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
	if update, ok := s.workerUpdates.active(deviceID, worker, time.Now().UTC()); ok && !update.Stalled && update.Failure == "" {
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
	startedAt := time.Now().UTC().Format(time.RFC3339Nano)
	s.workerUpdates.start(deviceID, store.DeviceWorkerUpdate{StartedAt: startedAt, Version: target, FromVersion: worker, Step: "starting"})
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
	s.workerUpdates.setLog(deviceID, value.Log)
	s.invalidateProjections()
	// Once the window passes, projections show the update as not finished.
	time.AfterFunc(workerUpdateWindow, s.invalidateProjections)
	if connection.hasCapability(workerUpdateStatusCapability) {
		go s.watchWorkerUpdate(deviceID, startedAt)
	}
	return value, nil
}

// watchWorkerUpdate asks the device's worker how its update is going until
// the device comes back on another version or the update fails: the worker
// reports a failed or silently ended update, or does not reconnect within
// the grace after restarting. A worker that comes back without the probe
// is left to the window.
func (s *Server) watchWorkerUpdate(deviceID, startedAt string) {
	probe, grace := s.workerUpdates.timing()
	started := time.Now()
	var away time.Time
	ticker := time.NewTicker(probe)
	defer ticker.Stop()
	for range ticker.C {
		now := time.Now()
		if now.Sub(started) >= workerUpdateWindow {
			return
		}
		connection := s.hub.connectionFor(deviceID)
		if connection == nil {
			if away.IsZero() {
				away = now
			}
			if now.Sub(away) >= grace {
				if s.workerUpdates.fail(deviceID, startedAt, workerUpdateFailedNotBack, "the worker did not come back after updating") {
					s.invalidateProjections()
				}
				return
			}
			continue
		}
		away = time.Time{}
		_, registration := connection.registrationSnapshot()
		version := ""
		if registration.Device.Worker != nil {
			version = registration.Device.Worker.Version
		}
		update, ok := s.workerUpdates.active(deviceID, version, now.UTC())
		if !ok || update.StartedAt != startedAt || update.Failure != "" {
			if !ok {
				s.invalidateProjections()
			}
			return
		}
		if !connection.hasCapability(workerUpdateStatusCapability) {
			continue
		}
		ctx, cancel := context.WithTimeout(connection.lifetime, probe)
		status, err := daemonRequest[wsWorkerUpdateStatus](ctx, connection, wsReadWorkerUpdateStatusType, []byte("{}"))
		cancel()
		if err != nil {
			continue
		}
		changed, settled := s.workerUpdates.apply(deviceID, startedAt, status)
		if changed {
			s.invalidateProjections()
		}
		if settled {
			return
		}
	}
}

// recordWorkerUpdateStatus takes a failure a worker reports unasked.
func (s *Server) recordWorkerUpdateStatus(deviceID string, status wsWorkerUpdateStatus) {
	if status.State != "failed" && status.State != "none" {
		return
	}
	if changed, _ := s.workerUpdates.apply(deviceID, "", status); changed {
		s.invalidateProjections()
	}
}

func (s *Server) handleUpdateWorker(w http.ResponseWriter, r *http.Request) {
	value, err := s.startWorkerUpdate(r.Context(), strings.TrimSpace(r.PathValue("deviceId")))
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, value)
}
