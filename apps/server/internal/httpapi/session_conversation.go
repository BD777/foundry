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
// A session token reads only its own session's: the worker starting it over
// holds that token, and nothing else needs this text.
func (s *Server) handleGetAgentSessionConversation(w http.ResponseWriter, r *http.Request) {
	session := guardedSession(r)
	if actor := actorFromContext(r.Context()); actor.Agent() && actor.Identity.SessionID != session.ID {
		writeForbidden(w, "a session token reads only its own conversation")
		return
	}
	text, err := s.store.AgentSessionConversation(r.Context(), session.ID)
	writeResult(w, map[string]string{"text": text}, err)
}
