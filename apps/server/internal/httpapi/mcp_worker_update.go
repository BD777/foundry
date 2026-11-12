package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/resources"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// updateWorkerForMCP updates an owned device's worker through the same path
// as the device page, or reports the versions and progress it records.
func (s *Server) updateWorkerForMCP(call mcpCall) (string, error) {
	deviceID := mcpArgString(call.args, "deviceId")
	action := mcpArgString(call.args, "action")
	if action == "" {
		action = "status"
	}
	switch action {
	case "start", "status":
	default:
		return "", &statusError{http.StatusBadRequest, errors.New("action must be start or status")}
	}
	if deviceID == "" {
		return "", &statusError{http.StatusBadRequest, errors.New("deviceId is required")}
	}

	device, err := s.ownedWorkerDevice(call.r.Context(), call.actor, deviceID)
	if err != nil {
		return "", err
	}
	if action == "start" {
		value, err := s.startWorkerUpdate(call.r.Context(), device.ID)
		if err != nil {
			return "", err
		}
		update, _ := s.workerUpdates.active(device.ID, "", time.Now().UTC())
		return encodeJSON(struct {
			DeviceID      string `json:"deviceId"`
			UpdateID      string `json:"updateId"`
			Started       bool   `json:"started"`
			StartedAt     string `json:"startedAt"`
			Step          string `json:"step"`
			TargetVersion string `json:"targetVersion"`
			Log           string `json:"log,omitempty"`
		}{
			DeviceID: device.ID, UpdateID: update.ID, Started: true, StartedAt: update.StartedAt, Step: update.Step,
			TargetVersion: update.Version, Log: value.Log,
		})
	}

	manifest, err := s.readWorkerRelease()
	if err != nil {
		return "", &statusError{http.StatusServiceUnavailable, errors.New("worker packages are configured but unreadable: " + err.Error())}
	}
	serverVersion := ""
	if manifest != nil {
		serverVersion = manifest.Version
	}
	workerVersion := ""
	if device.Worker != nil {
		workerVersion = device.Worker.Version
	}
	now := time.Now().UTC()
	update, active := s.workerUpdates.active(device.ID, workerVersion, now)
	last, completed := s.workerUpdates.lastCompleted(device.ID)
	connection := s.hub.deviceConnection(device.ID).State
	state := "none"
	inProgress := false
	switch {
	case active && update.Failure != "":
		state = "failed"
	case active && update.Stalled:
		state = "stalled"
	case active:
		state, inProgress = "in_progress", true
	case completed:
		update, state = last, "succeeded"
	}
	message := "No recent Worker update."
	switch {
	case active && update.Failure != "":
		message = "The Worker update failed during " + update.Step + "; see update.failure and update.logTail for details."
	case active && update.Stalled:
		message = "The Worker update has not finished; it may be started again."
	case active:
		message = "The Worker update is in progress"
		if update.Step != "" {
			message += " at step " + update.Step
		}
		if connection == resources.ConnectionReconnecting {
			message += "; the device is reconnecting after switching hosts"
		} else if connection == resources.ConnectionOffline {
			message += "; the device connection is temporarily unavailable while it restarts"
		}
		message += "."
	case completed:
		message = "The Worker updated from " + last.FromVersion + " to " + last.Version + "."
	}
	var elapsedMs int64
	if active {
		elapsedMs = update.ElapsedMs
	} else if completed {
		elapsedMs = last.ElapsedMs
	}
	var resultUpdate *store.DeviceWorkerUpdate
	switch {
	case active:
		resultUpdate = &update
	case completed:
		resultUpdate = &last
	}
	result := struct {
		DeviceID      string                    `json:"deviceId"`
		Online        bool                      `json:"online"`
		Connection    string                    `json:"connection"`
		WorkerVersion string                    `json:"workerVersion,omitempty"`
		ServerVersion string                    `json:"serverVersion,omitempty"`
		State         string                    `json:"state"`
		InProgress    bool                      `json:"inProgress"`
		ElapsedMs     int64                     `json:"elapsedMs,omitempty"`
		Message       string                    `json:"message"`
		Update        *store.DeviceWorkerUpdate `json:"update,omitempty"`
	}{
		DeviceID: device.ID, Online: connection == resources.ConnectionOnline, Connection: connection,
		WorkerVersion: workerVersion, ServerVersion: serverVersion, State: state, InProgress: inProgress,
		ElapsedMs: elapsedMs, Message: message, Update: resultUpdate,
	}
	return encodeJSON(result)
}

// ownedWorkerDevice resolves the account a call acts for and returns the
// device only when that account owns it. A workspace member who can see the
// device, and an admin, are both refused.
func (s *Server) ownedWorkerDevice(ctx context.Context, actor Actor, deviceID string) (store.DeviceProjection, error) {
	userID := actor.AccountID()
	if actor.Agent() {
		scope, err := s.contextScope(ctx, actor)
		if err != nil {
			return store.DeviceProjection{}, err
		}
		userID = scope.agentFor
	}
	if userID == "" {
		return store.DeviceProjection{}, deviceNotOwnedError(deviceID)
	}
	owner, err := s.store.DeviceOwner(ctx, deviceID)
	if err != nil {
		return store.DeviceProjection{}, err
	}
	if owner == "" || owner != userID {
		return store.DeviceProjection{}, deviceNotOwnedError(deviceID)
	}
	devices, err := s.store.ListDevices(ctx)
	if err != nil {
		return store.DeviceProjection{}, err
	}
	for _, device := range devices {
		if device.ID == deviceID {
			return device, nil
		}
	}
	return store.DeviceProjection{}, deviceNotOwnedError(deviceID)
}

func deviceNotOwnedError(deviceID string) error {
	return &statusError{http.StatusNotFound, errors.New("device " + deviceID + " was not found among devices you own")}
}
