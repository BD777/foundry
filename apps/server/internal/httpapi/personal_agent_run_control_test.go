package httpapi

import (
	"context"
	"errors"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
	"time"
)

func TestAssistantStopOfflineWaitsForEvidence(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	// Legacy inputs have no proof they were never sent. Going offline is not
	// proof that the native process ended, even when its DB status is queued.
	stopped, err := f.server.StopPersonalAgent(ctx, f.aliceID)
	if err != nil || stopped != 0 {
		t.Fatalf("offline execution claimed stopped: %d %v", stopped, err)
	}
	current, _ := f.server.store.GetAgentSessionSummary(ctx, f.conversation.ID)
	if current.Status == "canceled" {
		t.Fatal("disconnected native work was marked canceled")
	}
	b, _ := f.server.assistantRunControlStore()
	rows, err := b.ListPersonalAgentRunControls(ctx, f.aliceID)
	if err != nil || len(rows) != 1 || rows[0].State != "stop_requested" {
		t.Fatalf("no durable pending stop: %+v %v", rows, err)
	}
	if allowed, err := b.AuthorizePersonalAgentDispatch(ctx, current.ID, current.Input.ID); err != nil || allowed {
		t.Fatalf("stopped input could be redispatched: %v %v", allowed, err)
	}
}
func TestAssistantStopCannotCancelALaterInput(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	b, _ := f.server.assistantRunControlStore()
	old := f.conversation
	control, err := f.server.ensureAssistantRunControl(ctx, old)
	if err != nil {
		t.Fatal(err)
	}
	control, err = b.RequestPersonalAgentRunStop(ctx, f.aliceID, control.ID, "test")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.server.store.CompleteAgentSession(ctx, old.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	next, err := f.server.store.SendAgentSessionInput(ctx, old.ID, store.SendAgentSessionInput{Prompt: "New independent input", InputID: flow.InputID("next")})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = b.CancelPersonalAgentInput(ctx, old.ID, old.Input.ID, "late stop"); !errors.Is(err, store.ErrPersonalAgentRevision) {
		t.Fatalf("late stop accepted: %v", err)
	}
	f.server.reconcileAssistantRunControl(ctx, b, control)
	current, _ := f.server.store.GetAgentSessionSummary(ctx, old.ID)
	if current.Input.ID != next.Input.ID || current.Status != "queued" {
		t.Fatalf("new input canceled: %+v", current)
	}
	receipt, _ := b.GetPersonalAgentRunControl(ctx, f.aliceID, control.ID)
	if receipt.State != "input_moved" {
		t.Fatalf("incorrect receipt: %+v", receipt)
	}
}
func TestAssistantUnsentInputCanStopWithoutDevice(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	b, _ := f.server.assistantRunControlStore()
	session := f.conversation
	c, err := b.EnsurePersonalAgentRunControl(ctx, store.PersonalAgentRunControl{ID: flow.Key("parctl", session.ID, session.Input.ID), UserID: f.aliceID, SessionID: session.ID, InputID: session.Input.ID, Role: "coordinator", DispatchAttempted: false})
	if err != nil {
		t.Fatal(err)
	}
	c, err = b.RequestPersonalAgentRunStop(ctx, f.aliceID, c.ID, "test")
	if err != nil {
		t.Fatal(err)
	}
	f.server.reconcileAssistantRunControl(ctx, b, c)
	receipt, _ := b.GetPersonalAgentRunControl(ctx, f.aliceID, c.ID)
	if receipt.State != "stopped" || receipt.ConfirmedAt == "" {
		t.Fatalf("unsent input lacks confirmed cancellation: %+v", receipt)
	}
	if allowed, err := b.AuthorizePersonalAgentDispatch(ctx, session.ID, session.Input.ID); err != nil || allowed {
		t.Fatalf("cancelled input resent: %v %v", allowed, err)
	}
}

func TestAssistantProjectedCancellationNeedsNativeEndReceipt(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	b, _ := f.server.assistantRunControlStore()
	session := f.conversation
	c, err := b.EnsurePersonalAgentRunControl(ctx, store.PersonalAgentRunControl{ID: flow.Key("parctl", session.ID, session.Input.ID), UserID: f.aliceID, SessionID: session.ID, InputID: session.Input.ID, Role: "coordinator", DispatchAttempted: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.server.store.CancelAgentSession(ctx, session.ID, "Projected cancellation without device receipt"); err != nil {
		t.Fatal(err)
	}
	f.server.reconcileAssistantRunControl(ctx, b, c)
	pending, _ := b.GetPersonalAgentRunControl(ctx, f.aliceID, c.ID)
	if pending.State != "stop_requested" || pending.ConfirmedAt != "" {
		t.Fatalf("desired cancellation pretended to be native proof %+v", pending)
	}
	if err = b.NotePersonalAgentNativeEnd(ctx, session.ID, session.Input.ID, "canceled"); err != nil {
		t.Fatal(err)
	}
	done, _ := b.GetPersonalAgentRunControl(ctx, f.aliceID, c.ID)
	if done.State != "stopped" || done.NativeEndedAt == "" {
		t.Fatalf("native end not reconciled %+v", done)
	}
}

func TestAssistantStopRPCIsBoundedWhenDeviceDoesNotAnswer(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	f.daemon.ignoreCancel.Store(true)
	session, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_pa", AgentID: "agent_pa", Prompt: "Synthetic stalled device"})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := f.server.assistantRunControlStore()
	c, err := b.EnsurePersonalAgentRunControl(ctx, store.PersonalAgentRunControl{ID: flow.Key("parctl", session.ID, session.Input.ID), UserID: f.aliceID, SessionID: session.ID, InputID: session.Input.ID, DispatchAttempted: true})
	if err != nil {
		t.Fatal(err)
	}
	c, err = b.RequestPersonalAgentRunStop(ctx, f.aliceID, c.ID, "test")
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	f.server.reconcileAssistantRunControl(ctx, b, c)
	if time.Since(started) > 10*time.Second {
		t.Fatal("unresponsive device held the control request")
	}
	got, _ := b.GetPersonalAgentRunControl(ctx, f.aliceID, c.ID)
	if got.State != "stop_requested" || got.ConfirmedAt != "" {
		t.Fatalf("unanswered stop falsely confirmed %+v", got)
	}
}
func TestAssistantAcceptanceAndPauseBindBeforeDeviceDispatch(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	agent, _ := f.db.GetPersonalAgent(ctx, f.aliceID)
	snapshot, err := f.server.pinAssistantRun(ctx, agent, "pause-before-delivery", "coordinator", "ws_pa")
	if err != nil {
		t.Fatal(err)
	}
	session, err := f.db.CreateAgentSession(ctx, runSessionInput(snapshot, "Synthetic acceptance", snapshot.InputID))
	if err != nil {
		t.Fatal(err)
	}
	runs, _ := f.server.assistantRuntimeStore()
	accepted, err := runs.GetPersonalAgentRunSnapshot(ctx, f.aliceID, snapshot.ID)
	if err != nil || accepted.SessionID != session.ID {
		t.Fatalf("acceptance not atomically recorded %+v %v", accepted, err)
	}
	if _, err = f.db.SetPersonalAgentState(ctx, f.aliceID, store.PersonalAgentStopped); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.SetPersonalAgentState(ctx, f.aliceID, store.PersonalAgentActive); err != nil {
		t.Fatal(err)
	}
	b, _ := f.server.assistantRunControlStore()
	allowed, err := b.AuthorizePersonalAgentDispatch(ctx, session.ID, session.Input.ID)
	if err != nil || allowed {
		t.Fatalf("resume revived a paused accepted input: %v %v", allowed, err)
	}
}
