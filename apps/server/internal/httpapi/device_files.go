package httpapi

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Files of a device outside its workspaces, opened from a path an answer
// named. Only the device's owner, signed in through the browser, reaches
// them, and only while the owner's switch for the device is on; never a
// workspace member, a shared user, an admin or a session token. The device
// decides what may be shown (device-files.ts): credential stores are
// refused, a file that looks like a secret is masked until revealed and
// never downloaded. Contents pass through without being kept or logged;
// each opening is recorded without them.

const deviceFilesCapability = "device_files_v1"

// The request header the app sends with every device file request: a
// cross-site page cannot set it, and a navigation never carries it.
const (
	deviceFileIntentHeader = "X-Foundry-Intent"
	deviceFileIntent       = "device-file"
)

// deviceFileOpening is a request that passed the gate.
type deviceFileOpening struct {
	deviceID   string
	userID     string
	connection *daemonConnection
}

// openDeviceFiles lets through only the device's owner, signed in, with the
// app's intent header, while the owner's switch is on and the device runs
// a worker that serves device files; it answers the refusal otherwise.
func (s *Server) openDeviceFiles(w http.ResponseWriter, r *http.Request) (deviceFileOpening, bool) {
	w.Header().Set("Cache-Control", "no-store")
	deviceID := strings.TrimSpace(r.PathValue("deviceId"))
	actor := actorFromContext(r.Context())
	userID := actor.AccountID()
	if actor.Kind != ActorAccount || userID == "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"code": "owner_only", "error": "only the device's owner, signed in, opens its files"})
		return deviceFileOpening{}, false
	}
	if owner, err := s.deviceOwnerOf(r, deviceID); err != nil || owner == "" || owner != userID {
		writeError(w, http.StatusNotFound, "device not found")
		return deviceFileOpening{}, false
	}
	if r.Header.Get(deviceFileIntentHeader) != deviceFileIntent {
		writeJSON(w, http.StatusForbidden, map[string]string{"code": "intent_required", "error": "open device files from Foundry"})
		return deviceFileOpening{}, false
	}
	off, err := s.store.DevicesWithOutsideFilesOff(r.Context(), []string{deviceID})
	if err != nil {
		writeResult(w, nil, err)
		return deviceFileOpening{}, false
	}
	if off[deviceID] {
		writeJSON(w, http.StatusForbidden, map[string]string{"code": "device_files_off", "error": "opening this device's files from chats is turned off on its Devices page"})
		return deviceFileOpening{}, false
	}
	connection := s.hub.connectionFor(deviceID)
	if connection == nil {
		w.Header().Set("Retry-After", "1")
		writeJSON(w, http.StatusConflict, map[string]string{"code": "device_offline", "error": "The device is offline; its files open once it reconnects."})
		return deviceFileOpening{}, false
	}
	if !connection.hasCapability(deviceFilesCapability) {
		writeJSON(w, http.StatusConflict, map[string]string{"code": "worker_update_required", "error": "Update the device's worker to open its files from chats."})
		return deviceFileOpening{}, false
	}
	return deviceFileOpening{deviceID: deviceID, userID: userID, connection: connection}, true
}

// record keeps one opening, never its contents. A failure to record is
// logged and does not hide the file from its owner.
func (s *Server) recordDeviceFileAccess(ctx context.Context, opening deviceFileOpening, path, action, result string, bytes int64) {
	err := s.store.RecordDeviceFileAccess(context.WithoutCancel(ctx), store.DeviceFileAccess{
		DeviceID: opening.deviceID, UserID: opening.userID, Path: path,
		Action: action, Result: result, Bytes: bytes, At: time.Now(),
	})
	if err != nil {
		log.Printf("device file access on %s not recorded: %v", opening.deviceID, err)
	}
}

// handleReadDeviceFile answers what a file is (mode=stat), its start
// unless it looks like a secret (mode=read, the default), or its start
// even then (mode=reveal; purpose=copy when it goes to the clipboard).
func (s *Server) handleReadDeviceFile(w http.ResponseWriter, r *http.Request) {
	opening, ok := s.openDeviceFiles(w, r)
	if !ok {
		return
	}
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	mode := strings.TrimSpace(r.URL.Query().Get("mode"))
	if mode == "" {
		mode = "read"
	}
	if path == "" || (mode != "stat" && mode != "read" && mode != "reveal") {
		writeError(w, http.StatusBadRequest, "path and a mode of stat, read or reveal are required")
		return
	}
	action := mode
	if mode == "reveal" && r.URL.Query().Get("purpose") == "copy" {
		action = "copy"
	}
	ctx, cancel := context.WithTimeout(r.Context(), deviceFileRequestTimeout)
	defer cancel()
	answer, err := callDevice[wsDeviceFileRead](ctx, opening.connection, wsReadDeviceFileType, wsReadDeviceFilePayload{Path: path, Mode: mode})
	if err != nil {
		s.recordDeviceFileAccess(r.Context(), opening, path, action, "error", 0)
		if errors.Is(err, context.DeadlineExceeded) {
			w.Header().Set("Retry-After", "1")
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"code": "device_slow", "error": "The device did not answer in time; try again."})
			return
		}
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	var shown int64
	if answer.Content != nil {
		shown = int64(len(*answer.Content))
	}
	s.recordDeviceFileAccess(r.Context(), opening, path, action, answer.Kind, shown)
	switch answer.Kind {
	case "file":
		writeJSON(w, http.StatusOK, answer)
	case "denied":
		writeJSON(w, http.StatusForbidden, map[string]string{"code": "file_denied", "error": "Foundry does not open credential stores, browser profiles or system secrets."})
	case "not_file":
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"code": "not_a_file", "error": "This is not a regular file."})
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"code": "file_missing", "error": "The file was not found on the device."})
	}
}

// handleDownloadDeviceFile streams a file the owner may download: the
// device refuses one that looks like a secret on every chunk.
func (s *Server) handleDownloadDeviceFile(w http.ResponseWriter, r *http.Request) {
	opening, ok := s.openDeviceFiles(w, r)
	if !ok {
		return
	}
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	s.recordDeviceFileAccess(r.Context(), opening, path, "download", "requested", 0)
	s.downloadDeviceFile(w, r, opening.deviceID, deviceFilesCapability, func(ctx context.Context, c *daemonConnection, path string, request wsFileDownloadRequest) (*wsFileDownloadChunk, error) {
		value, err := callDevice[wsDeviceFileRead](ctx, c, wsReadDeviceFileType, wsReadDeviceFilePayload{Path: path, Mode: "stat", Download: &request})
		if err == nil && value.DownloadChunk == nil {
			err = fileDownloadRefusal{"not_found", "the file is not on the device"}
		}
		return value.DownloadChunk, err
	})
}

// handleSetDeviceOutsideFiles turns opening the device's files outside its
// workspaces from chats on or off; only its owner, signed in.
func (s *Server) handleSetDeviceOutsideFiles(w http.ResponseWriter, r *http.Request) {
	deviceID := strings.TrimSpace(r.PathValue("deviceId"))
	actor := actorFromContext(r.Context())
	if actor.Kind != ActorAccount {
		writeError(w, http.StatusForbidden, "only the device's owner, signed in, changes this")
		return
	}
	var input struct {
		Enabled *bool `json:"enabled"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if input.Enabled == nil {
		writeError(w, http.StatusBadRequest, "enabled is required")
		return
	}
	if err := s.store.SetDeviceOutsideFilesOff(r.Context(), deviceID, !*input.Enabled, actor.AccountID()); err != nil {
		writeResult(w, nil, err)
		return
	}
	// Open chats drop or draw the links at once (device projections carry it).
	s.dataChanges.changed("", fieldDevices)
	writeJSON(w, http.StatusOK, map[string]bool{"enabled": *input.Enabled})
}

// withOutsideFilesSwitch marks the caller's own devices whose switch is off.
func (s *Server) withOutsideFilesSwitch(ctx context.Context, devices []store.DeviceProjection) []store.DeviceProjection {
	owned := []string{}
	for i := range devices {
		devices[i].OutsideFilesOff = false
		if devices[i].Owned {
			owned = append(owned, devices[i].ID)
		}
	}
	if len(owned) == 0 {
		return devices
	}
	off, err := s.store.DevicesWithOutsideFilesOff(ctx, owned)
	if err != nil {
		log.Printf("device file switches not listed: %v", err)
		return devices
	}
	for i := range devices {
		devices[i].OutsideFilesOff = devices[i].Owned && off[devices[i].ID]
	}
	return devices
}
