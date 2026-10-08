package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type wsNativeAccountInspectionResult struct {
	Result store.NativeAccountInspection `json:"result"`
	// Registration refreshes the device's agents with what the check found.
	Registration store.DaemonRegistration `json:"registration"`
	Error        string                   `json:"error,omitempty"`
}

func (s *Server) handleInspectNativeAccount(w http.ResponseWriter, r *http.Request) {
	deviceID, runtime, ok := s.deviceAccountTarget(w, r)
	if !ok {
		return
	}
	var input struct {
		Source string `json:"source,omitempty"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	result, err := s.hub.InspectNativeAccount(r.Context(), deviceID, runtime, input.Source)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusConflict, "device disconnected")
		return
	}
	writeResult(w, result, err)
}

// InspectNativeAccount asks a device which native login a runtime would use.
// The device answers with a fresh registration too, so its agents stop
// showing a status from before, say, the CLI was installed.
func (h *DaemonHub) InspectNativeAccount(ctx context.Context, deviceID, runtime, source string) (store.NativeAccountInspection, error) {
	connection := h.connectionFor(deviceID)
	if connection == nil {
		return store.NativeAccountInspection{}, store.ErrNotFound
	}
	payload, err := json.Marshal(struct {
		Runtime string `json:"runtime"`
		Source  string `json:"source,omitempty"`
	}{runtime, source})
	if err != nil {
		return store.NativeAccountInspection{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 35*time.Second)
	defer cancel()
	value, err := daemonRequest[wsNativeAccountInspectionResult](ctx, connection, wsInspectNativeAccountType, payload)
	if err != nil {
		return store.NativeAccountInspection{}, err
	}
	if value.Error != "" {
		return store.NativeAccountInspection{}, errors.New(value.Error)
	}
	if value.Registration.Device.ID != "" {
		if err := connection.syncRegistration(value.Registration); err != nil {
			return store.NativeAccountInspection{}, err
		}
	}
	return value.Result, nil
}

type wsNativeCliInstallResult struct {
	Result       store.NativeCliInstallResult `json:"result"`
	Registration store.DaemonRegistration     `json:"registration"`
	Error        string                       `json:"error,omitempty"`
}

// handleInstallNativeCli runs the official installer for a runtime's program
// on the device, at its owner's request.
func (s *Server) handleInstallNativeCli(w http.ResponseWriter, r *http.Request) {
	deviceID, runtime, ok := s.deviceAccountTarget(w, r)
	if !ok {
		return
	}
	result, err := s.hub.InstallNativeCli(r.Context(), deviceID, runtime)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusConflict, "device disconnected")
		return
	}
	writeResult(w, result, err)
}

// InstallNativeCli asks a device to install Claude Code or Codex the official
// way. The device answers with a fresh registration, so its agents show the
// program it now has.
func (h *DaemonHub) InstallNativeCli(ctx context.Context, deviceID, runtime string) (store.NativeCliInstallResult, error) {
	connection := h.connectionFor(deviceID)
	if connection == nil {
		return store.NativeCliInstallResult{}, store.ErrNotFound
	}
	payload, err := json.Marshal(struct {
		Runtime string `json:"runtime"`
	}{runtime})
	if err != nil {
		return store.NativeCliInstallResult{}, err
	}
	// The installer itself may take minutes; the worker stops it at ten.
	ctx, cancel := context.WithTimeout(ctx, 11*time.Minute)
	defer cancel()
	value, err := daemonRequest[wsNativeCliInstallResult](ctx, connection, wsInstallNativeCliType, payload)
	if err != nil {
		return store.NativeCliInstallResult{}, err
	}
	if value.Error != "" {
		return store.NativeCliInstallResult{}, errors.New(value.Error)
	}
	if value.Registration.Device.ID != "" {
		if err := connection.syncRegistration(value.Registration); err != nil {
			return store.NativeCliInstallResult{}, err
		}
	}
	return value.Result, nil
}

// An account belongs to a native runtime on a specific device. Starting login
// must not create a reusable server profile or enable a different device.
func (s *Server) deviceAccountTarget(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	deviceID, runtime := strings.TrimSpace(r.PathValue("deviceId")), r.PathValue("runtime")
	if runtime != "claude" && runtime != "codex" {
		writeError(w, http.StatusBadRequest, "runtime must be claude or codex")
		return "", "", false
	}
	devices, err := s.store.ListDevices(r.Context())
	if err != nil {
		writeResult(w, nil, err)
		return "", "", false
	}
	for _, device := range devices {
		if device.ID == deviceID {
			if device.Status != deviceStatusConnected || !s.hub.HasConnection(deviceID) {
				writeError(w, http.StatusConflict, "connect this device before checking or signing in")
				return "", "", false
			}
			return deviceID, runtime, true
		}
	}
	writeError(w, http.StatusNotFound, "device not found")
	return "", "", false
}
