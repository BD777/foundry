package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// handleDeleteDevice performs a soft removal: the device is tombstoned so it
// leaves the available device list and can never re-register, but its chats,
// issues, runs, sessions and workspace registrations are all preserved. The
// store refuses the operation while non-terminal work exists; this handler
// never cancels or stops tasks. A connected, idle daemon is dropped with a
// permanent close (4001/device_removed) so its worker stops reconnecting.
func (s *Server) handleDeleteDevice(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("deviceId"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "device id is required")
		return
	}
	device, err := s.store.SoftRemoveDevice(r.Context(), id)
	if errors.Is(err, store.ErrDeviceBusy) {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	s.hub.closeRemovedDevice(id)
	writeResult(w, device, nil)
}
