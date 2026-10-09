package httpapi

import (
	"context"
	"net/http"
)

// sessionConversationStore is the store capability behind starting a native
// session over.
type sessionConversationStore interface {
	AgentSessionConversation(ctx context.Context, sessionID string) (string, error)
}

// handleGetAgentSessionConversation answers with the session's conversation
// before its current input, as text: what a worker tells a native session
// that has to start over without its history (its transcript is gone, or
// the endpoint refused it).
func (s *Server) handleGetAgentSessionConversation(w http.ResponseWriter, r *http.Request) {
	anchor, err := s.store.GetAgentSessionSummary(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if !s.canReadSession(r.Context(), actorFromContext(r.Context()), anchor) {
		writeForbidden(w, "session token cannot read this session")
		return
	}
	conversations, ok := s.store.(sessionConversationStore)
	if !ok {
		writeError(w, http.StatusNotImplemented, "this server's store cannot render a conversation")
		return
	}
	text, err := conversations.AgentSessionConversation(r.Context(), anchor.ID)
	writeResult(w, map[string]string{"text": text}, err)
}
