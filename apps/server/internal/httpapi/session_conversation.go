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
	text, err := s.store.AgentSessionConversation(r.Context(), guardedSession(r).ID)
	writeResult(w, map[string]string{"text": text}, err)
}
