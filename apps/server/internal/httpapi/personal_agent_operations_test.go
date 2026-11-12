package httpapi

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestAssistantOperationDispatchAndLostReceipt(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	parent, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_pa", AgentID: "agent_pa", Prompt: "Compare export formats"})
	if err != nil {
		t.Fatal(err)
	}
	item, err := f.db.AddPersonalAgentItem(ctx, store.PersonalAgentListItem{AssistantID: agent.ID, UserID: f.aliceID, Text: "Compare formats", Plan: &store.PersonalAgentItemPlan{Mode: "execute", Progress: "ready", WorkspaceID: "ws_budget"}})
	if err != nil {
		t.Fatal(err)
	}
	op, err := f.server.store.CapturePersonalAgentOperation(ctx, store.PersonalAgentOperation{ID: "paop_test", AssistantID: agent.ID, UserID: f.aliceID, ItemID: item.ID, IntentRevision: item.IntentRevision, StepKey: "compare", WorkspaceID: "ws_budget", SourceSessionID: parent.ID, InputID: flow.InputID("paop_test"), Prompt: "Compare formats and report sources", RequestHash: "hash"})
	if err != nil {
		t.Fatal(err)
	}
	f.server.assistant.DeliverOperation(ctx, op)
	saved, err := f.server.store.GetPersonalAgentOperation(ctx, agent.ID, op.ID)
	if err != nil || saved.Status != "delivered" {
		t.Fatalf("dispatch: %+v %v", saved, err)
	}
	run := f.daemon.nextChatRun()
	if run.Session.Input.ID != op.InputID || run.Session.WorkspaceID != "ws_budget" {
		t.Fatalf("wrong run: %+v", run.Session)
	}
	if run.Session.Title != item.Text {
		t.Fatalf("execution title exposed control metadata: %q", run.Session.Title)
	}
	// A stale dispatcher attempts the same operation again; it sees the native receipt.
	f.server.assistant.DeliverOperation(ctx, op)
	sessions, _ := f.db.ListAgentSessionSummaries(ctx, "ws_budget")
	if len(sessions) != 1 {
		t.Fatalf("duplicate executions: %d", len(sessions))
	}
	f.daemon.complete(run.Session, "Comparison prepared; review the source evidence")
	waitForStatus(t, f.db, run.Session.ID, "completed")
	saved, _ = f.server.store.GetPersonalAgentOperation(ctx, agent.ID, op.ID)
	f.server.assistant.DeliverOperation(ctx, saved)
	saved, _ = f.server.store.GetPersonalAgentOperation(ctx, agent.ID, op.ID)
	if saved.Status != "review" {
		t.Fatalf("missing review: %+v", saved)
	}
	actual, _ := f.db.GetPersonalAgentItem(ctx, agent.ID, item.ID)
	if actual.Status != "open" || actual.IntentRevision != item.IntentRevision || len(actual.Plan.WorkRefs) != 1 || actual.Plan.Progress != "review" || actual.TaskID == "" {
		t.Fatalf("bad item projection: %+v", actual)
	}
	snapshot, err := f.server.store.GetPersonalAgentRunSnapshot(ctx, agent.ID, flow.Key("parun", f.aliceID, op.ID))
	if err != nil || snapshot.SessionID != run.Session.ID {
		t.Fatalf("missing snapshot binding: %+v %v", snapshot, err)
	}
}

func TestAssistantOperationAdoptsExistingOwnerWithoutDuplicateTasks(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	parent, e := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_pa", AgentID: "agent_pa", Prompt: "Continue the synthetic comparison"})
	if e != nil {
		t.Fatal(e)
	}
	owner, e := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_budget", AgentID: "agent_budget", Prompt: "Existing comparison"})
	if e != nil {
		t.Fatal(e)
	}
	_, _ = f.db.CompleteAgentSession(ctx, owner.ID, "Ready for another step", "")
	item, e := f.db.AddPersonalAgentItem(ctx, store.PersonalAgentListItem{AssistantID: agent.ID, UserID: f.aliceID, Text: "Continue comparison", Plan: &store.PersonalAgentItemPlan{Mode: "execute", Progress: "ready", WorkspaceID: "ws_budget"}})
	if e != nil {
		t.Fatal(e)
	}
	op, e := f.server.store.CapturePersonalAgentOperation(ctx, store.PersonalAgentOperation{ID: "continue-existing", AssistantID: agent.ID, UserID: f.aliceID, ItemID: item.ID, IntentRevision: item.IntentRevision, StepKey: "next", WorkspaceID: "ws_budget", SourceSessionID: parent.ID, TargetSessionID: owner.ID, InputID: flow.InputID("continue-existing"), Prompt: "Continue with the agreed comparison", RequestHash: "request"})
	if e != nil {
		t.Fatal(e)
	}
	f.server.assistant.DeliverOperation(ctx, op)
	run := f.daemon.nextChatRun()
	if run.Session.ID != owner.ID {
		t.Fatal("existing owner replaced")
	}
	saved, _ := f.server.store.GetPersonalAgentOperation(ctx, agent.ID, op.ID)
	f.server.assistant.DeliverOperation(ctx, saved)
	tasks, e := f.db.ListPersonalAgentTasks(ctx, agent.ID, nil)
	if e != nil || len(tasks) != 1 || tasks[0].SessionID != owner.ID {
		t.Fatalf("task tracking duplicated %+v %v", tasks, e)
	}
	f.daemon.complete(run.Session, "Comparison is ready for review")
	waitForStatus(t, f.db, owner.ID, "completed")
	tasks, _ = f.db.ListPersonalAgentTasks(ctx, agent.ID, nil)
	if tasks[0].Status != store.PersonalAgentTaskDone {
		t.Fatal("unparented existing owner completion not followed")
	}
	saved, _ = f.server.store.GetPersonalAgentOperation(ctx, agent.ID, op.ID)
	f.server.assistant.DeliverOperation(ctx, saved)
	saved, _ = f.server.store.GetPersonalAgentOperation(ctx, agent.ID, op.ID)
	if saved.Status != "review" {
		t.Fatal("completion not projected", saved.Status)
	}
}

// Continuing a session keeps that session's own account and model (§f-4):
// only a new helper runs on the work-it-hands-off choice.
func TestAssistantContinuedSessionKeepsItsOwnModel(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	agent, e := f.db.GetPersonalAgent(ctx, f.aliceID)
	if e != nil {
		t.Fatal(e)
	}
	agent.Settings.RoleOverrides = map[string]store.PersonalAgentRunPreference{"executor": {ProfileID: "device_default", Model: "helper-model"}}
	if _, e = f.db.SavePersonalAgentSettings(ctx, agent.ID, agent.Settings); e != nil {
		t.Fatal(e)
	}
	parent, e := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_pa", AgentID: "agent_pa", Prompt: "Continue the synthetic comparison"})
	if e != nil {
		t.Fatal(e)
	}
	owner, e := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_budget", AgentID: "agent_budget", Model: "owner-model", Prompt: "Existing comparison"})
	if e != nil {
		t.Fatal(e)
	}
	_, _ = f.db.CompleteAgentSession(ctx, owner.ID, "Ready for another step", "")
	item, e := f.db.AddPersonalAgentItem(ctx, store.PersonalAgentListItem{AssistantID: agent.ID, UserID: f.aliceID, Text: "Continue comparison", Plan: &store.PersonalAgentItemPlan{Mode: "execute", Progress: "ready", WorkspaceID: "ws_budget"}})
	if e != nil {
		t.Fatal(e)
	}
	op, e := f.server.store.CapturePersonalAgentOperation(ctx, store.PersonalAgentOperation{ID: "continue-own-model", AssistantID: agent.ID, UserID: f.aliceID, ItemID: item.ID, IntentRevision: item.IntentRevision, StepKey: "next", WorkspaceID: "ws_budget", SourceSessionID: parent.ID, TargetSessionID: owner.ID, InputID: flow.InputID("continue-own-model"), Prompt: "Continue", RequestHash: "request"})
	if e != nil {
		t.Fatal(e)
	}
	f.server.assistant.DeliverOperation(ctx, op)
	saved, _ := f.server.store.GetPersonalAgentOperation(ctx, agent.ID, op.ID)
	if saved.Status != "delivered" {
		t.Fatalf("continuation waited: %+v", saved)
	}
	run := f.daemon.nextChatRun()
	if run.Session.ID != owner.ID || run.Session.Model != "owner-model" {
		t.Fatalf("continued on %s with model %q", run.Session.ID, run.Session.Model)
	}
	snapshot, e := f.server.store.GetPersonalAgentRunSnapshot(ctx, agent.ID, flow.Key("parun", f.aliceID, op.ID))
	if e != nil || snapshot.SelectionReason != "continued_session" || snapshot.Model != "owner-model" {
		t.Fatalf("snapshot: %+v %v", snapshot, e)
	}
}
