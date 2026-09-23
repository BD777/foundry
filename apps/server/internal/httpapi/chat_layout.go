package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) handleGetChatLayout(w http.ResponseWriter, r *http.Request) {
	workspaceID, allowed := effectiveWorkspace(actorFromContext(r.Context()), r.URL.Query().Get("workspaceId"))
	if !allowed {
		writeForbidden(w, "workspace is outside the token's scope")
		return
	}
	if strings.TrimSpace(workspaceID) == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	result, err := s.store.GetChatLayout(r.Context(), workspaceID)
	writeResult(w, result, err)
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
	writeResult(w, result, err)
}
