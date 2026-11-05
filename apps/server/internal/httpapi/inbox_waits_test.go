package httpapi

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// idleInboxFixture is an inbox fixture whose session finished its first turn.
func idleInboxFixture(t *testing.T) *inboxFixture {
	t.Helper()
	fixture := newInboxFixture(t, true)
	session, err := fixture.backing.CompleteAgentSession(context.Background(), fixture.session.ID, "ready", "")
	if err != nil {
		t.Fatal(err)
	}
	fixture.session = session
	return fixture
}

// familyInboxFixture is an idle parent (its first turn done) on the
// lineage fixture, where children can be created.
func familyInboxFixture(t *testing.T) *inboxFixture {
	t.Helper()
	db, parent := lineageFixture(t)
	ctx := context.Background()
	if _, err := db.StartAgentSession(ctx, parent.ID); err != nil {
		t.Fatal(err)
	}
	parent, err := db.CompleteAgentSession(ctx, parent.ID, "ready", "")
	if err != nil {
		t.Fatal(err)
	}
	return &inboxFixture{t: t, backing: db, server: NewServer(db), session: parent}
}

// runningChild is a child of the fixture's session in its first turn.
func (f *inboxFixture) runningChild(title string) store.AgentSession {
	f.t.Helper()
	ctx := context.Background()
	child, err := f.backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: f.session.WorkspaceID, AgentID: f.session.AgentID, Provider: f.session.Provider,
		Prompt: "fix it", Title: title, Source: "agent", ParentSessionID: f.session.ID,
	})
	if err != nil {
		f.t.Fatal(err)
	}
	if child, err = f.backing.StartAgentSession(ctx, child.ID); err != nil {
		f.t.Fatal(err)
	}
	return child
}

func (f *inboxFixture) current() store.AgentSession {
	f.t.Helper()
	session, err := f.backing.GetAgentSessionRecord(context.Background(), f.session.ID)
	if err != nil {
		f.t.Fatal(err)
	}
	return session
}

func withoutReportGather(t *testing.T) {
	previous := sessions.ChildReportGather
	sessions.ChildReportGather = 0
	t.Cleanup(func() { sessions.ChildReportGather = previous })
}

// DEV-119: a child's turn_end note to its idle parent waits for the
// child's turn and starts one parent turn with that turn's report; a
// boundary message still starts a turn at once, and a note that waited
// 10 minutes goes on its own.
func TestInboxChildTurnEndWaitsForTheChildsTurn(t *testing.T) {
	withoutReportGather(t)
	ctx := context.Background()
	t.Run("with the report", func(t *testing.T) {
		// The note came long enough before the turn ended not to be its
		// handoff (childReportHandoffWindow).
		window := childReportHandoffWindow
		childReportHandoffWindow = 0
		t.Cleanup(func() { childReportHandoffWindow = window })
		fixture := familyInboxFixture(t)
		child := fixture.runningChild("Fix QA")
		_, receipt, err := fixture.server.sessionService.SendInboxMessage(ctx, fixture.session, "", child.ID, store.DeliveryTurnEnd, "progress: MR !576 created", nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		if receipt.State != store.InboxHeld || receipt.DeliverAt != "sender_turn_end" {
			t.Fatalf("receipt = %+v, want held for the child's turn", receipt)
		}
		fixture.server.sessionService.PumpInbox(ctx)
		if status := fixture.current().Status; status != "completed" {
			t.Fatalf("parent status after the note = %s, want it still idle", status)
		}
		child, err = fixture.backing.CompleteAgentSession(ctx, child.ID, "MR !576 merged and deployed.", "")
		if err != nil {
			t.Fatal(err)
		}
		// The pump wakes before the report is admitted: the note waits for it.
		sessions.ChildReportGather = 300 * time.Millisecond
		t.Cleanup(func() { sessions.ChildReportGather = 0 })
		fixture.server.sessionService.PumpInbox(ctx)
		if got := fixture.item(receipt.InputID); got.State != store.InboxHeld {
			t.Fatalf("note right after the child's turn = %+v, want it to wait for the report", got)
		}
		childReportReactions{fixture.server}.SessionChanged(ctx, sessions.Completed, sessions.Slim(child))
		time.Sleep(350 * time.Millisecond)
		fixture.server.sessionService.PumpInbox(ctx)
		note := fixture.item(receipt.InputID)
		report := fixture.item(childReportInputID(child))
		if note.State != store.InboxDelivered || note.DeliveredInputID == "" || report.DeliveredInputID != note.DeliveredInputID {
			t.Fatalf("note = %+v\nreport = %+v\nwant both in one new turn", note, report)
		}
		input := fixture.current().Input.Prompt
		if !strings.Contains(input, "progress: MR !576 created") || !strings.Contains(input, "MR !576 merged and deployed.") {
			t.Fatalf("parent turn input lacks the note or the report:\n%s", input)
		}
	})
	t.Run("a handoff note goes alone when the turn ends", func(t *testing.T) {
		fixture := familyInboxFixture(t)
		child := fixture.runningChild("Fix QA")
		_, receipt, err := fixture.server.sessionService.SendInboxMessage(ctx, fixture.session, "", child.ID, store.DeliveryTurnEnd, "done: MR !576 deployed", nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		child, err = fixture.backing.CompleteAgentSession(ctx, child.ID, "done", "")
		if err != nil {
			t.Fatal(err)
		}
		childReportReactions{fixture.server}.SessionChanged(ctx, sessions.Completed, sessions.Slim(child))
		fixture.server.sessionService.PumpInbox(ctx)
		if note := fixture.item(receipt.InputID); note.State != store.InboxDelivered || fixture.current().Input.ID != note.DeliveredInputID {
			t.Fatalf("handoff note = %+v, want it to start the parent's turn", note)
		}
	})
	t.Run("boundary goes at once", func(t *testing.T) {
		fixture := familyInboxFixture(t)
		child := fixture.runningChild("Fix QA")
		_, receipt, err := fixture.server.sessionService.SendInboxMessage(ctx, fixture.session, "", child.ID, store.DeliveryBoundary, "please review MR !576", nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		if receipt.State != store.InboxDelivered || fixture.item(receipt.InputID).DeliveredAs != "turn" {
			t.Fatalf("boundary receipt = %+v, want a new turn at once", receipt)
		}
	})
	t.Run("a note that waited 10 minutes goes", func(t *testing.T) {
		fixture := familyInboxFixture(t)
		child := fixture.runningChild("Fix QA")
		old, err := fixture.backing.AdmitSessionInboxItem(ctx, store.SessionInboxItem{
			SessionID: fixture.session.ID, InputID: "0b1c2d3e-0000-4000-8000-000000000119", SenderSessionID: child.ID,
			Prompt: "progress: still running CI", RequestedDelivery: store.DeliveryTurnEnd,
		}, store.SessionInboxRules{Now: time.Now().Add(-sessions.InboxTurnEndFlush - time.Minute)})
		if err != nil {
			t.Fatal(err)
		}
		fixture.server.sessionService.PumpInbox(ctx)
		if got := fixture.item(old.Item.InputID); got.State != store.InboxDelivered {
			t.Fatalf("old note = %+v, want delivered", got)
		}
	})
}

// Instructions down to an idle child (or from any session that did not
// create the recipient's sender relation) are not held for the sender's turn.
func TestInboxTurnEndToAnIdleChildStartsAtOnce(t *testing.T) {
	fixture := familyInboxFixture(t)
	ctx := context.Background()
	child := fixture.runningChild("Fix QA")
	child, err := fixture.backing.CompleteAgentSession(ctx, child.ID, "done", "")
	if err != nil {
		t.Fatal(err)
	}
	parent, err := fixture.backing.SendAgentSessionInput(ctx, fixture.session.ID, store.SendAgentSessionInput{Prompt: "next step"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.backing.StartAgentSession(ctx, parent.ID); err != nil {
		t.Fatal(err)
	}
	_, receipt, err := fixture.server.sessionService.SendInboxMessage(ctx, child, "", parent.ID, store.DeliveryTurnEnd, "also update the ledger", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.State != store.InboxDelivered {
		t.Fatalf("receipt = %+v, want the idle child to start at once", receipt)
	}
}

// DEV-119: a turn that failed before its model answered (a provider 503)
// holds the messages it carried again instead of counting them read;
// while it stays failed, new messages wait for the retry instead of
// starting one failing turn each, and then go together.
func TestInboxFailedTurnHoldsItsMessagesAgain(t *testing.T) {
	previous := sessions.FailedTurnRetryBase
	t.Cleanup(func() { sessions.FailedTurnRetryBase = previous })
	sessions.FailedTurnRetryBase = time.Hour
	fixture := idleInboxFixture(t)
	ctx := context.Background()
	service := fixture.server.sessionService
	_, first, err := service.SendInboxMessage(ctx, fixture.session, "", "sess_child_a", store.DeliveryBoundary, "MR ready for review", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	started, err := fixture.backing.StartAgentSession(ctx, fixture.session.ID)
	if err != nil {
		t.Fatal(err)
	}
	service.InboxObserver().SessionChanged(ctx, sessions.Started, started)
	if got := fixture.item(first.InputID).State; got != store.InboxConsumed {
		t.Fatalf("state once the turn started = %s, want consumed", got)
	}
	failed, err := fixture.backing.FailAgentSession(ctx, fixture.session.ID, "API Error: 503 no eligible upstream account")
	if err != nil {
		t.Fatal(err)
	}
	service.InboxObserver().SessionChanged(ctx, sessions.Completed, failed)
	reopened := fixture.item(first.InputID)
	if reopened.State != store.InboxHeld || reopened.Reason != "turn_failed" || reopened.DeliveredInputID != "" || reopened.ConsumedAt != nil || reopened.Attempts != 1 {
		t.Fatalf("after the failed turn = %+v, want held again", reopened)
	}
	_, second, err := service.SendInboxMessage(ctx, fixture.session, "", "sess_child_b", store.DeliveryBoundary, "deploy finished", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if second.State != store.InboxHeld || second.DeliverAt != "after_failed_turn" {
		t.Fatalf("second receipt = %+v, want held after the failed turn", second)
	}
	service.PumpInbox(ctx)
	if status := fixture.current().Status; status != "failed" {
		t.Fatalf("status during the retry wait = %s, want no new turn", status)
	}
	// A new message on its own does not cut the wait its held ones earned.
	sessions.FailedTurnRetryBase = 300 * time.Millisecond
	time.Sleep(350 * time.Millisecond)
	_, third, err := service.SendInboxMessage(ctx, fixture.session, "", "sess_child_c", store.DeliveryBoundary, "CI is green", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if third.State != store.InboxHeld {
		t.Fatalf("third receipt = %+v, want held: the first message's wait (2 × base) has not passed", third)
	}
	time.Sleep(400 * time.Millisecond)
	service.PumpInbox(ctx)
	one, two := fixture.item(first.InputID), fixture.item(second.InputID)
	if one.State != store.InboxDelivered || one.DeliveredInputID == "" || two.DeliveredInputID != one.DeliveredInputID || fixture.item(third.InputID).DeliveredInputID != one.DeliveredInputID {
		t.Fatalf("after the retry wait: %+v / %+v, want all in one new turn", one, two)
	}
}

// A message steered into a turn that then fails before its model answered
// is held again too.
func TestInboxFailedTurnHoldsWhatWasSteeredIntoIt(t *testing.T) {
	fixture := idleInboxFixture(t)
	ctx := context.Background()
	service := fixture.server.sessionService
	parent, err := fixture.backing.SendAgentSessionInput(ctx, fixture.session.ID, store.SendAgentSessionInput{Prompt: "next step"})
	if err != nil {
		t.Fatal(err)
	}
	if parent, err = fixture.backing.StartAgentSession(ctx, parent.ID); err != nil {
		t.Fatal(err)
	}
	_, steered, err := service.SendInboxMessage(ctx, parent, "", "sess_child_a", store.DeliveryInterrupt, "stop and review", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	fixture.nextSteer()
	service.InboxObserver().SessionEventRecorded(ctx, store.AgentSessionEvent{ID: store.SessionInputEventID(steered.InputID), SessionID: parent.ID, Label: store.EventLabelSteeredIntoTurn})
	if got := fixture.waitState(steered.InputID, store.InboxDelivered); got.DeliveredAs != "steer" {
		t.Fatalf("steered = %+v", got)
	}
	failed, err := fixture.backing.FailAgentSession(ctx, parent.ID, "API Error: 503")
	if err != nil {
		t.Fatal(err)
	}
	service.InboxObserver().SessionChanged(ctx, sessions.Completed, failed)
	if got := fixture.item(steered.InputID); got.State != store.InboxHeld || got.Reason != "turn_failed" || got.DeliveredAs != "" {
		t.Fatalf("after the failed turn = %+v, want held again", got)
	}
}

// A turn whose model answered before it failed did read its input: its
// messages stay read.
func TestInboxFailedTurnAfterTheModelSpokeKeepsItsMessagesRead(t *testing.T) {
	fixture := idleInboxFixture(t)
	ctx := context.Background()
	service := fixture.server.sessionService
	_, first, err := service.SendInboxMessage(ctx, fixture.session, "", "sess_child_a", store.DeliveryBoundary, "MR ready for review", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	started, err := fixture.backing.StartAgentSession(ctx, fixture.session.ID)
	if err != nil {
		t.Fatal(err)
	}
	service.InboxObserver().SessionChanged(ctx, sessions.Started, started)
	if err := fixture.backing.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{
		ID: "evt_dev119_answer", SessionID: fixture.session.ID, At: time.Now().UTC().Format(time.RFC3339Nano),
		Label: store.EventLabelResponseStream, Detail: "Reviewing the MR now.", Level: "info",
	}); err != nil {
		t.Fatal(err)
	}
	failed, err := fixture.backing.FailAgentSession(ctx, fixture.session.ID, "tool crashed")
	if err != nil {
		t.Fatal(err)
	}
	service.InboxObserver().SessionChanged(ctx, sessions.Completed, failed)
	if got := fixture.item(first.InputID); got.State != store.InboxConsumed {
		t.Fatalf("after a failed turn that answered = %+v, want still consumed", got)
	}
}
