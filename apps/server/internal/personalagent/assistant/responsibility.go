package assistant

import (
	"context"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Who is responsible for a session (docs/assistant-orchestration.md §h, DEV-291):
// its questions, approvals, failures and items that need hands go to its
// creator, one layer at a time. A helper of an assistant goes to the
// assistant; a session another session created goes to that creator through
// its inbox; the person's own chats, and an assistant's own conversations (its
// home and message channels), go to the person. Nothing else answers.
// Every item source and every prompt routing reads this one rule.

const (
	// ResponsibleNobody: no one answers; prompts are denied at once.
	ResponsibleNobody = ""
	// ResponsiblePerson: the person answers in the session's own chat.
	ResponsiblePerson = "person"
	// ResponsibleAssistant: the assistant the session works for answers.
	ResponsibleAssistant = "assistant"
	// ResponsibleSession: the session that created it answers through its inbox.
	ResponsibleSession = "session"
	// responsibilityChainLimit bounds the walk up nested orchestrators.
	responsibilityChainLimit = 8
)

// Responsibility is who answers one session.
type Responsibility struct {
	Party string
	// Assistant is the assistant a helper works for (ResponsibleAssistant only).
	Assistant store.PersonalAgent
	// SessionID is the session that takes the session's questions through its
	// inbox: the assistant's conversation for a helper, the creating session
	// otherwise. "" once that session is gone; the question then waits in the
	// session's own chat.
	SessionID string
}

// Handler is who handles an item the session raises: its assistant, or the
// person.
func (r Responsibility) Handler() (handler, assistantID string) {
	if r.Party == ResponsibleAssistant {
		return store.PendingHandlerAssistant, r.Assistant.ID
	}
	return store.PendingHandlerPerson, ""
}

// assistantLookup says which assistant a session is a conversation of, or a
// helper of.
type assistantLookup interface {
	Conversation(ctx context.Context, session store.AgentSession) (store.PersonalAgent, bool)
	HelperOf(ctx context.Context, session store.AgentSession) (store.PersonalAgent, bool)
}

// sessionSummaries reads the sessions a chain of creators walks.
type sessionSummaries interface {
	GetAgentSessionSummary(ctx context.Context, id string) (store.AgentSession, error)
}

// ResponsibleFor is who answers session.
func (s *Service) ResponsibleFor(ctx context.Context, session store.AgentSession) Responsibility {
	return responsibleFor(ctx, s.store, s, session, 0)
}

func responsibleFor(ctx context.Context, summaries sessionSummaries, lookup assistantLookup, session store.AgentSession, depth int) Responsibility {
	if session.IssueID != "" || depth > responsibilityChainLimit {
		return Responsibility{}
	}
	// An assistant's own home and message-channel conversations: the person's.
	if _, ok := lookup.Conversation(ctx, session); ok {
		return Responsibility{Party: ResponsiblePerson}
	}
	if session.Role != "" {
		return Responsibility{}
	}
	if session.ParentSessionID == "" {
		if session.Source == "" || session.Source == store.SessionSourceChat {
			return Responsibility{Party: ResponsiblePerson}
		}
		return Responsibility{}
	}
	// Only a session an agent created answers to its creator: a scheduled run
	// (source chat) and a verifier answer to their own owners, not to a parent.
	if session.Source != store.SessionSourceAgent {
		return Responsibility{}
	}
	if agent, ok := lookup.HelperOf(ctx, session); ok {
		responsible := Responsibility{Party: ResponsibleAssistant, Assistant: agent}
		if parent, err := summaries.GetAgentSessionSummary(ctx, session.ParentSessionID); err == nil && isLiveCreator(parent) {
			responsible.SessionID = parent.ID
		}
		return responsible
	}
	parent, err := summaries.GetAgentSessionSummary(ctx, session.ParentSessionID)
	if err != nil || !isLiveCreator(parent) {
		return Responsibility{Party: ResponsibleSession}
	}
	if upstream := responsibleFor(ctx, summaries, lookup, parent, depth+1); upstream.Party == ResponsibleNobody {
		return Responsibility{}
	}
	return Responsibility{Party: ResponsibleSession, SessionID: parent.ID}
}

// isLiveCreator reports whether a creator still takes its children's
// questions: not archived, not canceled.
func isLiveCreator(session store.AgentSession) bool {
	return session.ArchivedAt == "" && session.Status != "canceled"
}
