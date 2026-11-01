package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) handleDaemonRegister(w http.ResponseWriter, r *http.Request) {
	var input store.DaemonRegistration
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !actorFromContext(r.Context()).ActsAsDevice(input.Device.ID) {
		writeError(w, http.StatusForbidden, "registration device does not match its credential")
		return
	}
	if _, err := s.hub.registerDaemon(r.Context(), input); err != nil {
		if errors.Is(err, store.ErrDeviceRemoved) {
			writeError(w, http.StatusGone, "device_removed")
			return
		}
		if errors.Is(err, store.ErrWorkspaceOwnedByAnotherDevice) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "registered"})
}

func (s *Server) handleDaemonSyncChats(w http.ResponseWriter, r *http.Request) {
	var input store.SyncChatsInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !s.requireDeviceWorkspace(w, r, input.WorkspaceID) {
		return
	}
	refused, err := s.hub.syncChats(r.Context(), input)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, syncedChats{Status: "synced", Count: len(input.Chats), Refused: refused})
}

// syncedChats answers a device's chat sync. Refused names the chats this
// server never keeps (deleted, or a Foundry session owns them), which the
// device need not send again; older workers ignore it.
type syncedChats struct {
	Status  string   `json:"status"`
	Count   int      `json:"count"`
	Refused []string `json:"refused,omitempty"`
}

// handleDaemonRunningChats names the device-native chats this server shows as
// running in a workspace. A worker syncs only its most recent native sessions,
// so it asks for these to re-check one that ended long ago and would
// otherwise stay "running" here forever.
func (s *Server) handleDaemonRunningChats(w http.ResponseWriter, r *http.Request) {
	workspaceID := strings.TrimSpace(r.URL.Query().Get("workspaceId"))
	if !s.requireDeviceWorkspace(w, r, workspaceID) {
		return
	}
	chats, err := s.store.ListChats(r.Context(), workspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	ids := []string{}
	for _, chat := range chats {
		if chat.NativeSessionID != "" && chat.Status == "running" {
			ids = append(ids, chat.ID)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"chatIds": ids})
}

func (s *Server) handleDaemonWebSocket(w http.ResponseWriter, r *http.Request) {
	s.hub.ServeHTTP(w, r)
}
