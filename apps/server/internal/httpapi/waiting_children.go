package httpapi

import (
	"context"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// waitingChildReactions invalidates the projections that show a parent's
// waiting status. A child state change can change its parent, grandparent,
// and so on; nesting is capped at four levels.
type waitingChildReactions struct {
	server *Server
}

func (r waitingChildReactions) SessionChanged(ctx context.Context, change sessions.Change, session store.AgentSession) {
	switch change {
	case sessions.Created, sessions.Queued, sessions.Started, sessions.Blocked, sessions.Resumed, sessions.Completed:
	default:
		return
	}
	if session.ParentSessionID == "" {
		return
	}

	parentID := session.ParentSessionID
	for depth := 0; depth < 4 && parentID != ""; depth++ {
		parent, err := r.server.store.GetAgentSessionSummary(ctx, parentID)
		if err != nil {
			return
		}
		r.server.projectionsChanged(parent.WorkspaceID, fieldAgentSessions)
		parentID = parent.ParentSessionID
	}
}
