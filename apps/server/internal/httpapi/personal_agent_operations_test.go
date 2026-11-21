package httpapi

import (
	"context"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
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
	item, err := f.db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{AssistantID: agent.ID, UserID: f.aliceID, Text: "Compare formats", HomeWorkspaceID: "ws_budget", Plan: &store.PersonalAgentItemPlan{Mode: "execute", Progress: "ready"}})
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
	page, _ := f.db.ListPersonalAgentItemPage(ctx, agent.ID, store.PersonalAgentItemFilter{})
	if actual.Status != "open" || actual.IntentRevision != item.IntentRevision || len(actual.Plan.WorkRefs) != 1 || actual.Plan.Progress != "review" || len(page.Helpers[item.ID]) == 0 {
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
	item, e := f.db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{AssistantID: agent.ID, UserID: f.aliceID, Text: "Continue comparison", HomeWorkspaceID: "ws_budget", Plan: &store.PersonalAgentItemPlan{Mode: "execute", Progress: "ready"}})
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
	item, e := f.db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{AssistantID: agent.ID, UserID: f.aliceID, Text: "Continue comparison", HomeWorkspaceID: "ws_budget", Plan: &store.PersonalAgentItemPlan{Mode: "execute", Progress: "ready"}})
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

// DEV-229: a write step waits for the session writing in its workspace and
// its dispatching conversation hears so after OperationQueuedNoticeAfter
// and again when it starts; a read-only step starts beside that session,
// and a session running a read-only step is no writer.
func TestAssistantOperationWaitsForTheWriterAndSaysSo(t *testing.T) {
	previous, after := assistant.CoalesceNotices, assistant.OperationQueuedNoticeAfter
	assistant.CoalesceNotices = 0
	t.Cleanup(func() { assistant.CoalesceNotices, assistant.OperationQueuedNoticeAfter = previous, after })
	f := newDigestFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	agent.Settings.Language = "en"
	if _, err := f.db.SavePersonalAgentSettings(ctx, agent.ID, agent.Settings); err != nil {
		t.Fatal(err)
	}
	conversation, err := f.server.sessionService.CreateAndDispatch(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_pa", AgentID: "agent_pa", Provider: "claude", Prompt: "check the release", Source: "chat",
	}, sessions.StartOptions{})
	if err != nil {
		t.Fatal(err)
	}
	f.daemon.complete(f.daemon.nextChatRun().Session, "On it.")
	waitForStatus(t, f.db, conversation.ID, "completed")
	// Runs of other sessions go by; the conversation's next one is a notice.
	told := func() string {
		t.Helper()
		for {
			run := f.daemon.nextChatRun()
			if run.Session.ID != conversation.ID {
				continue
			}
			stored, _ := f.db.GetAgentSession(ctx, conversation.ID)
			if !personalagent.IsNotice(stored.Input.Prompt) {
				t.Fatalf("the news reads as the person's words: %q", stored.Input.Prompt)
			}
			f.daemon.complete(run.Session, "Noted.")
			waitForStatus(t, f.db, conversation.ID, "completed")
			return stored.Input.Prompt
		}
	}
	writer, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_budget", AgentID: "agent_budget", Prompt: "long rerun"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.StartAgentSession(ctx, writer.ID); err != nil {
		t.Fatal(err)
	}
	capture := func(id string, readOnly bool) store.PersonalAgentOperation {
		t.Helper()
		item, err := f.db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{AssistantID: agent.ID, UserID: f.aliceID, Text: "Check " + id, HomeWorkspaceID: "ws_budget", Plan: &store.PersonalAgentItemPlan{Mode: "execute", Progress: "ready"}})
		if err != nil {
			t.Fatal(err)
		}
		op, err := f.server.store.CapturePersonalAgentOperation(ctx, store.PersonalAgentOperation{ID: id, AssistantID: agent.ID, UserID: f.aliceID, ItemID: item.ID, IntentRevision: item.IntentRevision, StepKey: id, WorkspaceID: "ws_budget", SourceSessionID: conversation.ID, InputID: flow.InputID(id), Prompt: "do " + id, RequestHash: id, ReadOnly: readOnly})
		if err != nil {
			t.Fatal(err)
		}
		return op
	}
	get := func(id string) store.PersonalAgentOperation {
		saved, err := f.server.store.GetPersonalAgentOperation(ctx, agent.ID, id)
		if err != nil {
			t.Fatal(err)
		}
		return saved
	}

	write := capture("write-step", false)
	f.server.assistant.DeliverOperation(ctx, write)
	saved := get(write.ID)
	if saved.Status != "waiting" || saved.Reason != "workspace_writer_busy" || saved.BusySessionID != writer.ID || saved.BusySince == "" || saved.WaitingSince == "" || saved.QueuedNoticeAt != "" {
		t.Fatalf("waiting write step: %+v", saved)
	}
	// Past the limit, the conversation hears it waits and for whom.
	assistant.OperationQueuedNoticeAfter = 0
	f.server.assistant.DeliverOperation(ctx, saved)
	if text := told(); !strings.Contains(text, "Queued: dispatched step write-step") || !strings.Contains(text, writer.ID) {
		t.Fatalf("queued notice: %q", text)
	}
	saved = get(write.ID)
	if saved.Status != "waiting" || saved.QueuedNoticeAt == "" {
		t.Fatalf("after the notice: %+v", saved)
	}
	f.server.assistant.DeliverOperation(ctx, saved)
	if again := get(write.ID); again.QueuedNoticeAt != saved.QueuedNoticeAt {
		t.Fatal("told twice")
	}

	// A read-only step starts beside the writer.
	read := capture("read-step", true)
	f.server.assistant.DeliverOperation(ctx, read)
	if saved := get(read.ID); saved.Status != "delivered" || saved.SessionID == "" {
		t.Fatalf("read-only step waited: %+v", saved)
	}
	helper, _ := f.db.GetAgentSession(ctx, get(read.ID).SessionID)
	if !strings.Contains(helper.Input.Prompt, "dispatched this step as read-only") {
		t.Fatalf("helper prompt: %q", helper.Input.Prompt)
	}

	// The writer ends; the read-only helper still runs and is no writer.
	if _, err := f.db.CompleteAgentSession(ctx, writer.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	f.server.assistant.DeliverOperation(ctx, get(write.ID))
	saved = get(write.ID)
	if saved.Status != "delivered" || saved.SessionID == "" {
		t.Fatalf("write step after the writer ended: %+v", saved)
	}
	if text := told(); !strings.Contains(text, "Started: dispatched step write-step") || !strings.Contains(text, saved.SessionID) {
		t.Fatalf("started notice: %q", text)
	}
}
