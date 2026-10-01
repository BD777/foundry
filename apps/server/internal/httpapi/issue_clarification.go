package httpapi

import (
	"context"
	"errors"
	"log"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// An Issue is clarified by an AgentSession with the issue_clarification role
// (sqlitestore/evidence_clarification.go). Its inputs are the person's
// messages; each completion settles the reply on the Issue.

var errIssueClarificationUnsupported = errors.New("worker_outdated: the workspace's worker cannot clarify Issues yet; update it")

// settleIssueSession hands what an Issue's session produced to the Issue.
func (h *DaemonHub) settleIssueSession(ctx context.Context, session store.AgentSession, execution *store.CompleteIssueInput, clarification *store.ClarificationResponse) {
	switch session.Role {
	case store.AgentSessionRoleIssueExecution:
		h.settleIssueExecution(ctx, session, execution)
	case store.AgentSessionRoleIssueClarification:
		h.settleIssueClarification(ctx, session, clarification)
	}
}

// settleIssueClarification records the clarification session's reply, or
// that it failed, on the Issue. A reply the device recorded still counts when
// the server had already given up on the session.
func (h *DaemonHub) settleIssueClarification(ctx context.Context, session store.AgentSession, reply *store.ClarificationResponse) {
	clarifications, ok := h.store.(store.EvidenceStore)
	if !ok {
		return
	}
	issue, err := clarifications.AnswerClarification(ctx, session, reply)
	if err != nil {
		log.Printf("answer clarification of issue %s from session %s: %v", session.IssueID, session.ID, err)
		return
	}
	h.events.Publish("issue_updated", issue)
}

// clarificationTurn loads what a clarification input needs, refusing a
// worker that would run it as an ordinary chat.
func (c *daemonConnection) clarificationTurn(ctx context.Context, session store.AgentSession) (*store.ClarificationTurn, error) {
	if !c.hasCapability(store.DaemonCapabilityIssueClarification) {
		return nil, errIssueClarificationUnsupported
	}
	clarifications, ok := c.hub.store.(store.EvidenceStore)
	if !ok {
		return nil, errIssueClarificationUnsupported
	}
	turn, err := clarifications.ClarificationTurn(ctx, session.IssueID)
	if err != nil {
		return nil, err
	}
	return &turn, nil
}
