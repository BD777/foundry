package httpapi

import "net/http"

func (s *Server) handleListChats(w http.ResponseWriter, r *http.Request) {
	workspaceID := requestedWorkspace(actorFromContext(r.Context()), r.URL.Query().Get("workspaceId"))
	items, err := s.store.ListChats(r.Context(), workspaceID)
	writeResult(w, items, err)
}

func (s *Server) handleGetChat(w http.ResponseWriter, r *http.Request) {
	item, err := s.store.GetChat(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, item, err)
		return
	}
	actor := actorFromContext(r.Context())
	if !s.canReadNativeChat(r.Context(), actor, item.WorkspaceID, item.ID) {
		writeForbidden(w, "session token cannot read this chat")
		return
	}
	writeResult(w, item, nil)
}
