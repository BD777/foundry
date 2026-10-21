package httpapi

import (
	"context"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
)

func TestAssistantOperationDispatchAndLostReceipt(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	parent, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_pa", AgentID: "agent_pa", Prompt: "Compare export formats"})
	if err != nil {
		t.Fatal(err)
	}
	item, err := f.db.AddPersonalAgentItem(ctx, store.PersonalAgentListItem{UserID: f.aliceID, Text: "Compare formats", Plan: &store.PersonalAgentItemPlan{Mode: "execute", Progress: "ready", WorkspaceID: "ws_budget"}})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := f.server.assistantOperationStore()
	op, err := b.CapturePersonalAgentOperation(ctx, store.PersonalAgentOperation{ID: "paop_test", UserID: f.aliceID, ItemID: item.ID, IntentRevision: item.IntentRevision, StepKey: "compare", WorkspaceID: "ws_budget", SourceSessionID: parent.ID, InputID: flow.InputID("paop_test"), Prompt: "Compare formats and report sources", RequestHash: "hash"})
	if err != nil {
		t.Fatal(err)
	}
	f.server.deliverPersonalAgentOperation(ctx, b, op)
	saved, err := b.GetPersonalAgentOperation(ctx, f.aliceID, op.ID)
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
	f.server.deliverPersonalAgentOperation(ctx, b, op)
	sessions, _ := f.db.ListAgentSessionSummaries(ctx, "ws_budget")
	if len(sessions) != 1 {
		t.Fatalf("duplicate executions: %d", len(sessions))
	}
	f.daemon.complete(run.Session, "Comparison prepared; review the source evidence")
	waitForStatus(t, f.db, run.Session.ID, "completed")
	saved, _ = b.GetPersonalAgentOperation(ctx, f.aliceID, op.ID)
	f.server.deliverPersonalAgentOperation(ctx, b, saved)
	saved, _ = b.GetPersonalAgentOperation(ctx, f.aliceID, op.ID)
	if saved.Status != "review" {
		t.Fatalf("missing review: %+v", saved)
	}
	actual, _ := f.db.GetPersonalAgentItem(ctx, f.aliceID, item.ID)
	if actual.Status != "open" || actual.IntentRevision != item.IntentRevision || len(actual.Plan.WorkRefs) != 1 || actual.Plan.Progress != "review" || actual.TaskID == "" {
		t.Fatalf("bad item projection: %+v", actual)
	}
	runs, _ := f.server.assistantRuntimeStore()
	snapshot, err := runs.GetPersonalAgentRunSnapshot(ctx, f.aliceID, flow.Key("parun", f.aliceID, op.ID))
	if err != nil || snapshot.SessionID != run.Session.ID {
		t.Fatalf("missing snapshot binding: %+v %v", snapshot, err)
	}
}

func TestAssistantOperationAdoptsExistingOwnerWithoutDuplicateTasks(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	parent, e := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_pa", AgentID: "agent_pa", Prompt: "Continue the synthetic comparison"})
	if e != nil {
		t.Fatal(e)
	}
	owner, e := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_budget", AgentID: "agent_budget", Prompt: "Existing comparison"})
	if e != nil {
		t.Fatal(e)
	}
	_, _ = f.db.CompleteAgentSession(ctx, owner.ID, "Ready for another step", "")
	item, e := f.db.AddPersonalAgentItem(ctx, store.PersonalAgentListItem{UserID: f.aliceID, Text: "Continue comparison", Plan: &store.PersonalAgentItemPlan{Mode: "execute", Progress: "ready", WorkspaceID: "ws_budget"}})
	if e != nil {
		t.Fatal(e)
	}
	b, _ := f.server.assistantOperationStore()
	op, e := b.CapturePersonalAgentOperation(ctx, store.PersonalAgentOperation{ID: "continue-existing", UserID: f.aliceID, ItemID: item.ID, IntentRevision: item.IntentRevision, StepKey: "next", WorkspaceID: "ws_budget", SourceSessionID: parent.ID, TargetSessionID: owner.ID, InputID: flow.InputID("continue-existing"), Prompt: "Continue with the agreed comparison", RequestHash: "request"})
	if e != nil {
		t.Fatal(e)
	}
	f.server.deliverPersonalAgentOperation(ctx, b, op)
	run := f.daemon.nextChatRun()
	if run.Session.ID != owner.ID {
		t.Fatal("existing owner replaced")
	}
	saved, _ := b.GetPersonalAgentOperation(ctx, f.aliceID, op.ID)
	f.server.deliverPersonalAgentOperation(ctx, b, saved)
	tasks, e := f.db.ListPersonalAgentTasks(ctx, f.aliceID, nil)
	if e != nil || len(tasks) != 1 || tasks[0].SessionID != owner.ID {
		t.Fatalf("task tracking duplicated %+v %v", tasks, e)
	}
	f.daemon.complete(run.Session, "Comparison is ready for review")
	waitForStatus(t, f.db, owner.ID, "completed")
	tasks, _ = f.db.ListPersonalAgentTasks(ctx, f.aliceID, nil)
	if tasks[0].Status != store.PersonalAgentTaskDone {
		t.Fatal("unparented existing owner completion not followed")
	}
	saved, _ = b.GetPersonalAgentOperation(ctx, f.aliceID, op.ID)
	f.server.deliverPersonalAgentOperation(ctx, b, saved)
	saved, _ = b.GetPersonalAgentOperation(ctx, f.aliceID, op.ID)
	if saved.Status != "review" {
		t.Fatal("completion not projected", saved.Status)
	}
}
