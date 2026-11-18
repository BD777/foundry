package httpapi

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// An answer to an assistant's question is the person's own words, so it is
// never merged into a turn with other held messages (DEV-293b): the answer
// starts a turn of its own, and the other message starts the next one, each
// with its own input and source.
func TestAnswerIsItsOwnTurnNotMergedWithOtherHeldMessages(t *testing.T) {
	fixture := newInboxFixture(t, false)
	ctx := context.Background()
	answerID := uuid.NewString()
	answerPrompt := personalagent.AnswerFrame("Which folder should the receipt go to?", "The Q3 folder, please.")
	if _, err := fixture.backing.AdmitSessionInboxItem(ctx, store.SessionInboxItem{
		SessionID:         fixture.session.ID,
		SenderSessionID:   fixture.session.ID,
		InputID:           answerID,
		Prompt:            answerPrompt,
		RequestedDelivery: store.DeliveryBoundary,
		InputSource:       &store.AgentSessionInputSource{Kind: "foundry_notice", NoticeKind: store.NoticeKindQuestionAnswer},
	}, store.SessionInboxRules{Now: time.Now().UTC(), DedupWindow: sessions.InboxDedupWindow}); err != nil {
		t.Fatal(err)
	}
	_, other, err := fixture.server.sessionService.SendInboxMessage(ctx, fixture.session, "", "sess_a", store.DeliveryBoundary, "a message from another session", nil, nil)
	if err != nil {
		t.Fatal(err)
	}

	// The two wait for the running turn to end; then the answer goes alone.
	if _, err := fixture.backing.StartAgentSession(ctx, fixture.session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.backing.CompleteAgentSession(ctx, fixture.session.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	fixture.server.sessionService.PumpInbox(ctx)
	answer := fixture.item(answerID)
	if answer.State != store.InboxDelivered || answer.DeliveredInputID == "" {
		t.Fatalf("answer after the turn ended = %+v, want delivered in a turn", answer)
	}
	session, err := fixture.backing.GetAgentSessionRecord(ctx, fixture.session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if session.Input.ID != answer.DeliveredInputID || session.Input.Prompt != answerPrompt {
		t.Fatalf("the answer's turn = %s %q, want the answer alone", session.Input.ID, session.Input.Prompt)
	}
	if source := session.Input.InputSource; source == nil || source.Kind != "foundry_notice" || source.NoticeKind != store.NoticeKindQuestionAnswer {
		t.Fatalf("the answer's source = %+v, want the question answer", source)
	}
	if otherItem := fixture.item(other.InputID); otherItem.DeliveredInputID != "" {
		t.Fatalf("the other message went out with the answer: %+v", otherItem)
	}

	// The other message starts its own turn once the answer's turn ends.
	if _, err := fixture.backing.CompleteAgentSession(ctx, fixture.session.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	fixture.server.sessionService.PumpInbox(ctx)
	otherItem := fixture.item(other.InputID)
	if otherItem.State != store.InboxDelivered || otherItem.DeliveredInputID == "" || otherItem.DeliveredInputID == answer.DeliveredInputID {
		t.Fatalf("other message after the answer's turn = %+v, want its own turn", otherItem)
	}
	session, err = fixture.backing.GetAgentSessionRecord(ctx, fixture.session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if session.Input.ID != otherItem.DeliveredInputID || !strings.Contains(session.Input.Prompt, "a message from another session") {
		t.Fatalf("the next turn = %s %q, want the other message", session.Input.ID, session.Input.Prompt)
	}
}
