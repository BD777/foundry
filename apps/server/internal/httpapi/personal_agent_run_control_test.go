package httpapi

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/run"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestAssistantStopOfflineWaitsForEvidence(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	// Legacy inputs have no proof they were never sent. Going offline is not
	// proof that the native process ended, even when its DB status is queued.
	stopped, err := f.server.assistant.Stop(ctx, agent)
	if err != nil || stopped != 0 {
		t.Fatalf("offline execution claimed stopped: %d %v", stopped, err)
	}
	current, _ := f.server.store.GetAgentSessionSummary(ctx, f.conversation.ID)
	if current.Status == "canceled" {
		t.Fatal("disconnected native work was marked canceled")
	}
	rows, err := f.server.store.ListPersonalAgentRunControls(ctx, agent.ID)
	if err != nil || len(rows) != 1 || rows[0].State != "stop_requested" {
		t.Fatalf("no durable pending stop: %+v %v", rows, err)
	}
	if allowed, err := f.server.store.AuthorizePersonalAgentDispatch(ctx, current.ID, current.Input.ID); err != nil || allowed {
		t.Fatalf("stopped input could be redispatched: %v %v", allowed, err)
	}
}
func TestAssistantStopCannotCancelALaterInput(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	old := f.conversation
	control, err := assistant.EnsureRunControl(ctx, f.server.store, old)
	if err != nil {
		t.Fatal(err)
	}
	control, err = f.server.store.RequestPersonalAgentRunStop(ctx, agent.ID, control.ID, "test")
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
	if _, _, err = f.server.store.CancelPersonalAgentInput(ctx, old.ID, old.Input.ID, "late stop"); !errors.Is(err, store.ErrPersonalAgentRevision) {
		t.Fatalf("late stop accepted: %v", err)
	}
	f.server.assistant.ReconcileRunControl(ctx, control)
	current, _ := f.server.store.GetAgentSessionSummary(ctx, old.ID)
	if current.Input.ID != next.Input.ID || current.Status != "queued" {
		t.Fatalf("new input canceled: %+v", current)
	}
	receipt, _ := f.server.store.GetPersonalAgentRunControl(ctx, agent.ID, control.ID)
	if receipt.State != "input_moved" {
		t.Fatalf("incorrect receipt: %+v", receipt)
	}
}
func TestAssistantUnsentInputCanStopWithoutDevice(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	session := f.conversation
	c, err := f.server.store.EnsurePersonalAgentRunControl(ctx, store.PersonalAgentRunControl{ID: flow.Key("parctl", session.ID, session.Input.ID), AssistantID: agent.ID, UserID: f.aliceID, SessionID: session.ID, InputID: session.Input.ID, Role: "coordinator", DispatchAttempted: false})
	if err != nil {
		t.Fatal(err)
	}
	c, err = f.server.store.RequestPersonalAgentRunStop(ctx, agent.ID, c.ID, "test")
	if err != nil {
		t.Fatal(err)
	}
	f.server.assistant.ReconcileRunControl(ctx, c)
	receipt, _ := f.server.store.GetPersonalAgentRunControl(ctx, agent.ID, c.ID)
	if receipt.State != "stopped" || receipt.ConfirmedAt == "" {
		t.Fatalf("unsent input lacks confirmed cancellation: %+v", receipt)
	}
	if allowed, err := f.server.store.AuthorizePersonalAgentDispatch(ctx, session.ID, session.Input.ID); err != nil || allowed {
		t.Fatalf("cancelled input resent: %v %v", allowed, err)
	}
}

func TestAssistantProjectedCancellationNeedsNativeEndReceipt(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	session := f.conversation
	c, err := f.server.store.EnsurePersonalAgentRunControl(ctx, store.PersonalAgentRunControl{ID: flow.Key("parctl", session.ID, session.Input.ID), AssistantID: agent.ID, UserID: f.aliceID, SessionID: session.ID, InputID: session.Input.ID, Role: "coordinator", DispatchAttempted: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.server.store.CancelAgentSession(ctx, session.ID, "Projected cancellation without device receipt"); err != nil {
		t.Fatal(err)
	}
	f.server.assistant.ReconcileRunControl(ctx, c)
	pending, _ := f.server.store.GetPersonalAgentRunControl(ctx, agent.ID, c.ID)
	if pending.State != "stop_requested" || pending.ConfirmedAt != "" {
		t.Fatalf("desired cancellation pretended to be native proof %+v", pending)
	}
	if err = f.server.store.NotePersonalAgentNativeEnd(ctx, session.ID, session.Input.ID, "canceled"); err != nil {
		t.Fatal(err)
	}
	done, _ := f.server.store.GetPersonalAgentRunControl(ctx, agent.ID, c.ID)
	if done.State != "stopped" || done.NativeEndedAt == "" {
		t.Fatalf("native end not reconciled %+v", done)
	}
}

func TestAssistantStopRPCIsBoundedWhenDeviceDoesNotAnswer(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	f.daemon.ignoreCancel.Store(true)
	session, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_pa", AgentID: "agent_pa", Prompt: "Synthetic stalled device"})
	if err != nil {
		t.Fatal(err)
	}
	c, err := f.server.store.EnsurePersonalAgentRunControl(ctx, store.PersonalAgentRunControl{ID: flow.Key("parctl", session.ID, session.Input.ID), AssistantID: agent.ID, UserID: f.aliceID, SessionID: session.ID, InputID: session.Input.ID, DispatchAttempted: true})
	if err != nil {
		t.Fatal(err)
	}
	c, err = f.server.store.RequestPersonalAgentRunStop(ctx, agent.ID, c.ID, "test")
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	f.server.assistant.ReconcileRunControl(ctx, c)
	if time.Since(started) > 10*time.Second {
		t.Fatal("unresponsive device held the control request")
	}
	got, _ := f.server.store.GetPersonalAgentRunControl(ctx, agent.ID, c.ID)
	if got.State != "stop_requested" || got.ConfirmedAt != "" {
		t.Fatalf("unanswered stop falsely confirmed %+v", got)
	}
}
func TestAssistantAcceptanceAndPauseBindBeforeDeviceDispatch(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	agent, _ := f.db.GetPersonalAgent(ctx, f.aliceID)
	snapshot, err := f.server.runs.Pin(ctx, agent, "pause-before-delivery", "coordinator", "ws_pa")
	if err != nil {
		t.Fatal(err)
	}
	session, err := f.db.CreateAgentSession(ctx, run.SessionInput(snapshot, "Synthetic acceptance", snapshot.InputID))
	if err != nil {
		t.Fatal(err)
	}
	accepted, err := f.server.store.GetPersonalAgentRunSnapshot(ctx, agent.ID, snapshot.ID)
	if err != nil || accepted.SessionID != session.ID {
		t.Fatalf("acceptance not atomically recorded %+v %v", accepted, err)
	}
	if _, err = f.db.SetPersonalAgentState(ctx, agent.ID, store.PersonalAgentStopped); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.SetPersonalAgentState(ctx, agent.ID, store.PersonalAgentActive); err != nil {
		t.Fatal(err)
	}
	allowed, err := f.server.store.AuthorizePersonalAgentDispatch(ctx, session.ID, session.Input.ID)
	if err != nil || allowed {
		t.Fatalf("resume revived a paused accepted input: %v %v", allowed, err)
	}
}
