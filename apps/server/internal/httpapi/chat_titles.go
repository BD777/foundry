package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) handleListChatTitles(w http.ResponseWriter, r *http.Request) {
	workspaceID, allowed := effectiveWorkspace(actorFromContext(r.Context()), r.URL.Query().Get("workspaceId"))
	if !allowed {
		writeForbidden(w, "workspace is outside the token's scope")
		return
	}
	items, err := s.store.ListChatTitles(r.Context(), workspaceID)
	writeResult(w, items, err)
}

func (s *Server) handleRenameChat(w http.ResponseWriter, r *http.Request) {
	var input store.RenameChatInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	actor := actorFromContext(r.Context())
	if actor.Agent() {
		input.WorkspaceID = actor.Identity.WorkspaceID
		target, err := s.store.GetAgentSessionSummary(r.Context(), r.PathValue("id"))
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		if !s.canControlSession(r.Context(), actor, target) {
			writeForbidden(w, "session token can only rename sessions it created")
			return
		}
	}
	if strings.TrimSpace(input.WorkspaceID) == "" || strings.TrimSpace(input.Title) == "" || utf8.RuneCountInString(strings.TrimSpace(input.Title)) > 120 {
		writeError(w, http.StatusBadRequest, "workspaceId and a title of 1–120 characters are required")
		return
	}
	result, err := s.store.RenameChat(r.Context(), r.PathValue("id"), input)
	if errors.Is(err, store.ErrTitleConflict) {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeResult(w, result, err)
}

func (s *Server) handleRecapChatTitle(w http.ResponseWriter, r *http.Request) {
	var input struct {
		WorkspaceID string `json:"workspaceId"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if strings.TrimSpace(input.WorkspaceID) == "" {
		writeError(w, http.StatusBadRequest, "workspaceId is required")
		return
	}
	job, err := s.titles.Start(r.Context(), input.WorkspaceID, r.PathValue("id"), false)
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, job)
}
