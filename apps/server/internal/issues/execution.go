package issues

import (
	"context"
	"log"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// An Issue is implemented by an AgentSession with the issue_execution role
// and clarified by one with the issue_clarification role. The execution's
// lifecycle drives the Issue's Run, where it stands: its id is the
// session's, and completion carries the candidate the session left. Its
// events are the session's.

// Observer is the session observer that starts an Issue's Run when its
// execution session starts.
func (s *Service) Observer() sessions.ChangeObserver { return executionStarts{s} }

type executionStarts struct{ s *Service }

func (r executionStarts) SessionChanged(ctx context.Context, change sessions.Change, session store.AgentSession) {
	if change != sessions.Started || session.Role != store.AgentSessionRoleIssueExecution {
		return
	}
	issue, err := r.s.store.StartIssueRun(ctx, session.IssueID, store.Run{
		ID:        session.ID,
		Runtime:   session.Provider,
		StartedAt: time.Now().UTC().Format(time.RFC3339),
	})
	if err != nil {
		log.Printf("start issue %s run for session %s: %v", session.IssueID, session.ID, err)
		return
	}
	r.s.events.Updated(issue)
}

// Settle hands what an Issue's session produced, once it ended, to the
// Issue: the execution's result, or the clarification's reply.
func (s *Service) Settle(ctx context.Context, session store.AgentSession, execution *store.CompleteIssueInput, clarification *store.ClarificationResponse) {
	switch session.Role {
	case store.AgentSessionRoleIssueExecution:
		s.settleExecution(ctx, session, execution)
	case store.AgentSessionRoleIssueClarification:
		s.settleClarification(ctx, session, clarification)
	}
}

// settleExecution completes the Issue once its execution session ends. A
// session that ended without a result (the device lost it, or the server
// marked it stale) blocks the Issue with the session's error; candidate
// files stay on the device for a retry.
func (s *Service) settleExecution(ctx context.Context, session store.AgentSession, result *store.CompleteIssueInput) {
	input := store.CompleteIssueInput{Error: session.Error}
	if input.Error == "" {
		input.Error = "The execution ended without a result."
	}
	input.Checks = []string{input.Error}
	if result != nil {
		input = *result
	}
	input.RunID = session.ID
	issue, err := s.store.CompleteIssue(ctx, session.IssueID, input)
	if err != nil {
		log.Printf("complete issue %s from session %s: %v", session.IssueID, session.ID, err)
		return
	}
	s.events.Updated(issue)
	s.devices.ClaimReady()
}

// settleClarification records the clarification session's reply, or that
// it failed, on the Issue. A reply the device recorded still counts when the
// server had already given up on the session.
func (s *Service) settleClarification(ctx context.Context, session store.AgentSession, reply *store.ClarificationResponse) {
	issue, err := s.store.AnswerClarification(ctx, session, reply)
	if err != nil {
		log.Printf("answer clarification of issue %s from session %s: %v", session.IssueID, session.ID, err)
		return
	}
	s.events.Updated(issue)
}
