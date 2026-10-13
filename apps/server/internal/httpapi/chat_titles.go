package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Browsers read a workspace's chat titles (GET /api/chat-titles) and chat
// layout (GET /api/chat-layout) once, then keep them from the chat list's
// events (see chatListEvents).

// writeCacheableResult answers a list the browser keeps current from
// events with an ETag: reading it again unchanged costs no body.
func writeCacheableResult(w http.ResponseWriter, r *http.Request, payload any, err error) {
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	body, err := json.Marshal(payload)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeCacheableJSON(w, r, body)
}

func (s *Server) handleListChatTitles(w http.ResponseWriter, r *http.Request) {
	workspaceID := requestedWorkspace(actorFromContext(r.Context()), r.URL.Query().Get("workspaceId"))
	items, err := s.store.ListChatTitles(r.Context(), workspaceID)
	writeCacheableResult(w, r, items, err)
}

func (s *Server) handleRenameChat(w http.ResponseWriter, r *http.Request) {
	var input store.RenameChatInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	actor := actorFromContext(r.Context())
	if actor.Agent() {
		input.WorkspaceID = actor.Identity.WorkspaceID
		target := guardedSession(r)
		if target.ID == "" {
			writeResult(w, nil, store.ErrNotFound)
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
	if err == nil {
		s.chats.announceTitles(input.WorkspaceID, result.ChatID)
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
