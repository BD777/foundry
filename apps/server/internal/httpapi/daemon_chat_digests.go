package httpapi

import (
	"net/http"
	"strings"
)

// handleDaemonChatDigests tells a worker which of its workspace's native
// chats this server already holds, and in what state. A worker without a
// record of its own uploads (first run after an update, or a lost state
// root) compares them with its chats and sends only those that differ,
// instead of every chat with its full transcript.
func (s *Server) handleDaemonChatDigests(w http.ResponseWriter, r *http.Request) {
	workspaceID := strings.TrimSpace(r.URL.Query().Get("workspaceId"))
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}
	if !s.requireDeviceWorkspace(w, r, workspaceID) {
		return
	}
	chats, err := s.store.ChatDigests(r.Context(), workspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"chats": chats})
}
