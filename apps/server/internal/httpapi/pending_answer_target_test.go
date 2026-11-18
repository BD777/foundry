package httpapi

import (
	"context"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// An answer envelope settles only the question item it names: another open
// question of the same chat stays open.
func TestAnswerEnvelopeSettlesOnlyTheItemItNames(t *testing.T) {
	f := newNeedsYouFixture(t)
	ctx := context.Background()
	questionEventOf(t, f, f.chat, "qc", "Which colour?", "")
	questionEventOf(t, f, f.chat, "qd", "Which size?", "")

	steer := store.AgentSessionEvent{
		ID: "evt_answer_qc", SessionID: f.chat.ID, At: formatPendingTime(time.Now()), Label: store.EventLabelSteeredIntoTurn,
		Detail: agentQuestionReplyText("item_qc", "Which colour?", "Blue"),
	}
	if _, err := f.db.RecordAgentSessionEvent(ctx, steer); err != nil {
		t.Fatal(err)
	}
	pendingReactions{f.server}.SessionEventRecorded(ctx, steer)

	answered := itemsInStates(t, f, store.PendingReplied)
	if item, ok := answered["Which colour?"]; !ok || len(answered) != 1 || item.Answer != "Blue" || item.AnsweredBy != store.PendingAnsweredByPerson {
		t.Fatalf("answered = %+v, want only Which colour? answered Blue by person", answered)
	}
	if open := openItemsOf(t, f); len(open) != 1 || open["Which size?"].ID == "" {
		t.Fatalf("open = %+v, want only Which size? still open", open)
	}
}

// A plain steer that is no answer envelope answers the session's open
// questions as before.
func TestPlainSteerAnswersEverySessionQuestion(t *testing.T) {
	f := newNeedsYouFixture(t)
	ctx := context.Background()
	questionEventOf(t, f, f.chat, "qc", "Which colour?", "")
	questionEventOf(t, f, f.chat, "qd", "Which size?", "")

	steer := store.AgentSessionEvent{
		ID: "evt_plain", SessionID: f.chat.ID, At: formatPendingTime(time.Now()), Label: store.EventLabelSteeredIntoTurn,
		Detail: "Blue, medium",
	}
	if _, err := f.db.RecordAgentSessionEvent(ctx, steer); err != nil {
		t.Fatal(err)
	}
	pendingReactions{f.server}.SessionEventRecorded(ctx, steer)

	if answered := itemsInStates(t, f, store.PendingReplied); len(answered) != 2 || answered["Which size?"].Answer != "Blue, medium" {
		t.Fatalf("answered = %+v, want both questions answered by the plain steer", answered)
	}
}
