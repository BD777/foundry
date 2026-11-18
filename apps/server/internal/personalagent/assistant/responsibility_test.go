package assistant

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type stubSummaries map[string]store.AgentSession

func (m stubSummaries) GetAgentSessionSummary(_ context.Context, id string) (store.AgentSession, error) {
	if session, ok := m[id]; ok {
		return session, nil
	}
	return store.AgentSession{}, store.ErrNotFound
}

// stubLookup answers which assistant a session is a conversation of or a
// helper of, by session id.
type stubLookup struct {
	conversations map[string]store.PersonalAgent
	helpers       map[string]store.PersonalAgent
}

func (l stubLookup) Conversation(_ context.Context, session store.AgentSession) (store.PersonalAgent, bool) {
	agent, ok := l.conversations[session.ID]
	return agent, ok
}

func (l stubLookup) HelperOf(_ context.Context, session store.AgentSession) (store.PersonalAgent, bool) {
	agent, ok := l.helpers[session.ID]
	return agent, ok
}

// Who is responsible for each kind of session, by the creator chain (DEV-291):
// the person's own chats and an assistant's own conversations, a helper of
// an assistant, a session another session created, and nothing for the rest.
func TestResponsibleForFollowsTheCreatorChain(t *testing.T) {
	assistantAgent := store.PersonalAgent{ID: "pa_1", UserID: "u"}
	sessions := stubSummaries{
		"chat":          {ID: "chat", Source: store.SessionSourceChat, CreatedByUserID: "u"},
		"home":          {ID: "home", Source: store.SessionSourceChat, Role: store.AgentSessionRolePersonalAgent, CreatedByUserID: "u"},
		"channel":       {ID: "channel", Source: store.SessionSourceChat, CreatedByUserID: "u"},
		"helper":        {ID: "helper", Source: store.SessionSourceAgent, ParentSessionID: "home", CreatedByUserID: "u"},
		"helperChild":   {ID: "helperChild", Source: store.SessionSourceAgent, ParentSessionID: "helper", CreatedByUserID: "u"},
		"orchestrator":  {ID: "orchestrator", Source: store.SessionSourceAgent, ParentSessionID: "chat", CreatedByUserID: "u"},
		"child":         {ID: "child", Source: store.SessionSourceAgent, ParentSessionID: "orchestrator", CreatedByUserID: "u"},
		"lostChild":     {ID: "lostChild", Source: store.SessionSourceAgent, ParentSessionID: "deleted", CreatedByUserID: "u"},
		"archivedChild": {ID: "archivedChild", Source: store.SessionSourceAgent, ParentSessionID: "archived", CreatedByUserID: "u"},
		"archived":      {ID: "archived", Source: store.SessionSourceChat, ArchivedAt: "2026-11-06T00:00:00Z", CreatedByUserID: "u"},
		"stoppedHelper": {ID: "stoppedHelper", Source: store.SessionSourceAgent, ParentSessionID: "canceled", CreatedByUserID: "u"},
		"canceled":      {ID: "canceled", Source: store.SessionSourceChat, Status: "canceled", CreatedByUserID: "u"},
		"scheduled":     {ID: "scheduled", Source: store.SessionSourceChat, ParentSessionID: "chat", CreatedByUserID: "u"},
		"scheduledRun":  {ID: "scheduledRun", Source: store.SessionSourceAgent, ParentSessionID: "scheduled", CreatedByUserID: "u"},
		"verifier":      {ID: "verifier", Source: store.SessionSourceVerification, ParentSessionID: "chat", CreatedByUserID: "u"},
		"issueRun":      {ID: "issueRun", Source: store.SessionSourceIssue, IssueID: "iss_1", CreatedByUserID: "u"},
		"issueChild":    {ID: "issueChild", Source: store.SessionSourceAgent, ParentSessionID: "issueRun", CreatedByUserID: "u"},
		"utility":       {ID: "utility", Source: store.SessionSourceNaming},
	}
	lookup := stubLookup{
		conversations: map[string]store.PersonalAgent{"home": assistantAgent, "channel": assistantAgent},
		helpers:       map[string]store.PersonalAgent{"helper": assistantAgent, "stoppedHelper": assistantAgent},
	}
	for _, check := range []struct {
		name, id, party, sessionID, handler, assistantID string
	}{
		{"person's own chat", "chat", ResponsiblePerson, "", store.PendingHandlerPerson, ""},
		{"assistant's home", "home", ResponsiblePerson, "", store.PendingHandlerPerson, ""},
		{"assistant's message channel", "channel", ResponsiblePerson, "", store.PendingHandlerPerson, ""},
		{"assistant's helper", "helper", ResponsibleAssistant, "home", store.PendingHandlerAssistant, "pa_1"},
		{"helper's own helper", "helperChild", ResponsibleSession, "helper", store.PendingHandlerPerson, ""},
		{"helper whose conversation is gone", "stoppedHelper", ResponsibleAssistant, "", store.PendingHandlerAssistant, "pa_1"},
		{"orchestrator child", "orchestrator", ResponsibleSession, "chat", store.PendingHandlerPerson, ""},
		{"child of an orchestrator", "child", ResponsibleSession, "orchestrator", store.PendingHandlerPerson, ""},
		{"child whose creator is gone", "lostChild", ResponsibleSession, "", store.PendingHandlerPerson, ""},
		{"child of an archived creator", "archivedChild", ResponsibleSession, "", store.PendingHandlerPerson, ""},
		{"scheduled run", "scheduled", ResponsibleNobody, "", store.PendingHandlerPerson, ""},
		{"run under a scheduled run", "scheduledRun", ResponsibleNobody, "", store.PendingHandlerPerson, ""},
		{"verifier", "verifier", ResponsibleNobody, "", store.PendingHandlerPerson, ""},
		{"issue run", "issueRun", ResponsibleNobody, "", store.PendingHandlerPerson, ""},
		{"child of an issue run", "issueChild", ResponsibleNobody, "", store.PendingHandlerPerson, ""},
		{"utility", "utility", ResponsibleNobody, "", store.PendingHandlerPerson, ""},
	} {
		t.Run(check.name, func(t *testing.T) {
			got := responsibleFor(context.Background(), sessions, lookup, sessions[check.id], 0)
			if got.Party != check.party || got.SessionID != check.sessionID {
				t.Fatalf("responsibleFor(%s) = party %q via %q; want party %q via %q", check.id, got.Party, got.SessionID, check.party, check.sessionID)
			}
			handler, assistantID := got.Handler()
			if handler != check.handler || assistantID != check.assistantID {
				t.Errorf("Handler(%s) = %q, %q; want %q, %q", check.id, handler, assistantID, check.handler, check.assistantID)
			}
		})
	}
}

// A chain of creators answers through its first session the person's chat
// reaches; one deeper than the limit answers nothing.
func TestResponsibleForStopsAtTheChainLimit(t *testing.T) {
	sessions := stubSummaries{"root": {ID: "root", Source: store.SessionSourceChat, CreatedByUserID: "u"}}
	parent := "root"
	for index := 1; index <= responsibilityChainLimit+1; index++ {
		id := "c" + string(rune('a'+index))
		sessions[id] = store.AgentSession{ID: id, Source: store.SessionSourceAgent, ParentSessionID: parent, CreatedByUserID: "u"}
		parent = id
	}
	shallow := sessions["cb"]
	if got := responsibleFor(context.Background(), sessions, stubLookup{}, shallow, 0); got.Party != ResponsibleSession || got.SessionID != "root" {
		t.Fatalf("a chain of one creator answers %q via %q, want a session via root", got.Party, got.SessionID)
	}
	if got := responsibleFor(context.Background(), sessions, stubLookup{}, sessions[parent], 0); got.Party != ResponsibleNobody {
		t.Fatalf("a chain deeper than %d answers %q, want nobody", responsibilityChainLimit, got.Party)
	}
}
