package httpapi

import (
	"context"
	"net/http"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The home conversation's unread marker (DEV-278). Foundry records the
// newest answer of the person's conversation with their assistant, and the
// web records when the person looked at it; whether an answer is unseen is
// state, never a judgement about its content.

// homeAnswerReactions records an answer once the home conversation's turn
// ended.
type homeAnswerReactions struct{ s *Server }

func (r homeAnswerReactions) SessionChanged(ctx context.Context, change sessions.Change, session store.AgentSession) {
	if change != sessions.Completed {
		return
	}
	r.s.assistant.RecordHomeAnswer(ctx, session)
}

// GET /api/personal-agent/home-unread (and /api/assistants/{assistant}/…).
func (s *Server) handleAssistantHomeUnread(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	state, err := s.assistant.HomeUnread(r.Context(), agent)
	writeResult(w, state, err)
}

// POST /api/personal-agent/home-seen: the person is looking at the home
// conversation now, so every answer it holds is seen.
func (s *Server) handleMarkAssistantHomeSeen(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	if err := s.assistant.MarkHomeSeen(r.Context(), agent); err != nil {
		writeResult(w, nil, err)
		return
	}
	state, err := s.assistant.HomeUnread(r.Context(), agent)
	writeResult(w, state, err)
}
