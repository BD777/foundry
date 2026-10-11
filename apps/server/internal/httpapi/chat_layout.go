package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) handleGetChatLayout(w http.ResponseWriter, r *http.Request) {
	workspaceID := requestedWorkspace(actorFromContext(r.Context()), r.URL.Query().Get("workspaceId"))
	if strings.TrimSpace(workspaceID) == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}
	// no-cache with an ETag: always checked with the server (a saved
	// revision is never served stale), and free when unchanged.
	result, err := s.store.GetChatLayout(r.Context(), workspaceID)
	writeCacheableResult(w, r, result, err)
}

func (s *Server) handleSaveChatLayout(w http.ResponseWriter, r *http.Request) {
	var input store.SaveChatLayoutInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !s.requireWorkspace(w, r, strings.TrimSpace(input.WorkspaceID), store.WorkspaceRoleMember) {
		return
	}
	result, err := s.store.SaveChatLayout(r.Context(), input)
	if errors.Is(err, store.ErrChatLayoutConflict) {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	if errors.Is(err, store.ErrInvalidChatLayout) {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err == nil {
		s.chats.layoutChanged(input.WorkspaceID, result)
	}
	writeResult(w, result, err)
}

func (s *Server) handleDeleteChatGroup(w http.ResponseWriter, r *http.Request) {
	var input store.DeleteChatGroupInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !s.requireWorkspace(w, r, strings.TrimSpace(input.WorkspaceID), store.WorkspaceRoleMember) {
		return
	}
	result, err := s.store.DeleteChatGroup(r.Context(), input)
	if errors.Is(err, store.ErrChatLayoutConflict) || errors.Is(err, store.ErrChatDeletionBusy) {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	if errors.Is(err, store.ErrInvalidChatLayout) {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err == nil {
		// The group's chats and their sessions are deleted with it. Their
		// titles stay (GET /api/chat-titles lists them still).
		s.chats.layoutChanged(input.WorkspaceID, result)
		s.projectionsChanged(input.WorkspaceID, fieldChats, fieldAgentSessions)
	}
	writeResult(w, result, err)
}
