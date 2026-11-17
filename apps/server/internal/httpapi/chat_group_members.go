package httpapi

import (
	"net/http"
	"strconv"
	"strings"
)

// handleChatGroupMemberCounts answers how many chats each folder can list,
// so a folder can show the ones the session list's window leaves out.
func (s *Server) handleChatGroupMemberCounts(w http.ResponseWriter, r *http.Request) {
	workspaceID := requestedWorkspace(actorFromContext(r.Context()), r.URL.Query().Get("workspaceId"))
	counts, err := s.store.ChatGroupMemberCounts(r.Context(), workspaceID)
	writeResult(w, counts, err)
}

// handleChatGroupMemberSessions reads one page of a folder's chats, newest
// activity first, for the rows a folder adds when the person expands it.
func (s *Server) handleChatGroupMemberSessions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	workspaceID := requestedWorkspace(actorFromContext(ctx), r.URL.Query().Get("workspaceId"))
	groupID := strings.TrimSpace(r.URL.Query().Get("groupId"))
	if groupID == "" {
		writeError(w, http.StatusBadRequest, "groupId is required")
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	items, next, err := s.store.ListChatGroupMemberSessions(ctx, workspaceID, groupID, r.URL.Query().Get("cursor"), limit)
	if err == nil {
		items = summarizeAgentSessionsForList(s.sessionService.ReconcileAll(ctx, items))
		items, err = s.withWaitingChildCounts(ctx, items)
		if err == nil {
			items = s.presentSessions(ctx, items)
		}
	}
	writeResult(w, map[string]any{"sessions": items, "nextCursor": next}, err)
}
