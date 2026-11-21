package httpapi

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/sessionalerts"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// endTurn runs a session's current input to its end and reports it, as the
// session service's observers would.
func endTurn(t *testing.T, server *Server, sessionID, answer string) store.AgentSession {
	t.Helper()
	ctx := context.Background()
	if current, err := server.store.GetAgentSessionSummary(ctx, sessionID); err != nil || current.Status == "queued" {
		if _, err := server.store.StartAgentSession(ctx, sessionID); err != nil {
			t.Fatalf("start %s: %v", sessionID, err)
		}
	}
	ended, err := server.store.CompleteAgentSession(ctx, sessionID, answer, "native-"+sessionID)
	if err != nil {
		t.Fatalf("complete %s: %v", sessionID, err)
	}
	childReportReactions{server}.SessionChanged(ctx, sessions.Completed, sessions.Slim(ended))
	return ended
}

// archiveSession ends a session's turn and archives it.
func archiveSession(t *testing.T, server *Server, session store.AgentSession) {
	t.Helper()
	ctx := context.Background()
	current, err := server.store.GetAgentSessionSummary(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.Status == "queued" {
		if _, err := server.store.StartAgentSession(ctx, session.ID); err != nil {
			t.Fatal(err)
		}
	}
	if current.Status == "queued" || current.Status == "running" {
		if _, err := server.store.CompleteAgentSession(ctx, session.ID, "done", "native-"+session.ID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := server.store.ArchiveChats(ctx, store.ArchiveChatsInput{WorkspaceID: session.WorkspaceID, ChatIDs: []string{session.ID}}, false); err != nil {
		t.Fatalf("archive %s: %v", session.ID, err)
	}
}

// reportsFrom lists what sender reported to recipient.
func reportsFrom(t *testing.T, server *Server, recipientID, senderID string) []store.SessionInboxItem {
	t.Helper()
	items, err := server.store.SessionInboxItems(context.Background(), recipientID, time.Now().Add(-time.Hour), 100)
	if err != nil {
		t.Fatal(err)
	}
	var reports []store.SessionInboxItem
	for _, item := range items {
		if item.SenderSessionID == senderID && strings.HasPrefix(item.Prompt, sessions.ChildReportPrefix) {
			reports = append(reports, item)
		}
	}
	return reports
}

// The person's orchestration session in a workspace hands a helper an item
// of that workspace, then is archived. With no session following the item
// (the assistant's conversation archived too), the helper's report waits on
// the item instead of being dropped; the session that claims the item next
// gets it, and the helper's later reports go straight to that holder.
func TestItemHelperReportWaitsForTheNextHolder(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	orchestrator := f.startSession(t, "ws_alice", "", "track the release checklist for the launch")
	token := f.mint(t, orchestrator.ID)
	added, text, failed := f.updateItem(t, token, "add", map[string]any{"text": "Release checklist", "quote": "track the release checklist"})
	if failed {
		t.Fatalf("add: %s", text)
	}
	item := added.Item

	text, failed = f.tool(t, token, "create_session", map[string]any{"workspaceId": "ws_alice", "prompt": "walk the release checklist", "itemId": item.ID})
	if failed {
		t.Fatalf("create_session itemId from a workspace session: %s", text)
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(text), &created); err != nil || created.ID == "" {
		t.Fatalf("create_session answer %q", text)
	}
	if ref, err := f.server.store.PersonalAgentItemOfHelper(ctx, created.ID); err != nil || ref.ItemID != item.ID || ref.AssistantID != agent.ID {
		t.Fatalf("helper link = %+v %v", ref, err)
	}
	// Not the assistant's work: no task, so neither its task list nor its
	// sessions count it.
	if tasks, _ := f.server.store.ListPersonalAgentTasks(ctx, agent.ID, nil); len(tasks) != 0 {
		t.Fatalf("a workspace session's helper became the assistant's task: %+v", tasks)
	}

	archiveSession(t, f.server, orchestrator)
	archiveSession(t, f.server, f.conversation)
	endTurn(t, f.server, created.ID, "The checklist has two open steps.")
	waiting, err := f.server.store.WaitingPersonalAgentItemSignals(ctx, agent.ID, item.ID)
	if err != nil || len(waiting) != 1 || !strings.Contains(waiting[0].Prompt, "two open steps") {
		t.Fatalf("waiting signals = %+v %v, want the report", waiting, err)
	}

	successor := f.startSession(t, "ws_alice", "", "take over the release checklist")
	if _, text, failed := f.updateItem(t, f.mint(t, successor.ID), "claim", map[string]any{"id": item.ID}); failed {
		t.Fatalf("claim: %s", text)
	}
	got := reportsFrom(t, f.server, successor.ID, created.ID)
	if len(got) != 1 || !strings.Contains(got[0].Prompt, "two open steps") ||
		!strings.Contains(got[0].Prompt, "which works on item "+item.ID+" that this session follows") ||
		!strings.Contains(got[0].Prompt, "Foundry kept this on item "+item.ID) {
		t.Fatalf("the claimer's reports = %+v", got)
	}
	if waiting, _ := f.server.store.WaitingPersonalAgentItemSignals(ctx, agent.ID, item.ID); len(waiting) != 0 {
		t.Fatalf("signals still wait after the claim: %+v", waiting)
	}

	// The holder is live now: the helper's next turn reports to it at once.
	if _, err := f.server.store.SendAgentSessionInput(ctx, created.ID, store.SendAgentSessionInput{Prompt: "and the last step?"}); err != nil {
		t.Fatal(err)
	}
	endTurn(t, f.server, created.ID, "The last step is the changelog.")
	if got := reportsFrom(t, f.server, successor.ID, created.ID); len(got) != 2 || !strings.Contains(got[0].Prompt+got[1].Prompt, "changelog") {
		t.Fatalf("the holder's reports = %+v", got)
	}
}

// A helper the assistant handed an item reports to the item's live holder
// (here a workspace session that claimed it), not to the conversation that
// handed it off; the holder's plain answer to its question is the answer.
func TestItemHelperReportsToTheLiveHolder(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	item := addItem(t, f, agent, "Check the gateway deploy", store.PersonalAgentItemOwnerAssistant)
	item.HomeWorkspaceID, item.Revision = "ws_alice", 0
	if _, err := f.server.store.SavePersonalAgentItem(ctx, store.PersonalAgentActorPerson, item); err != nil {
		t.Fatal(err)
	}
	helper := f.startSession(t, "ws_alice", f.conversation.ID, "check the gateway deploy")
	f.server.assistant.RecordTask(ctx, agent, f.conversation.ID, helper, item.ID)
	holder := f.startSession(t, "ws_alice", "", "follow the gateway deploy")
	if _, text, failed := f.updateItem(t, f.mint(t, holder.ID), "claim", map[string]any{"id": item.ID}); failed {
		t.Fatalf("claim: %s", text)
	}

	endTurn(t, f.server, helper.ID, "The deploy is green.")
	if got := reportsFrom(t, f.server, holder.ID, helper.ID); len(got) != 1 || !strings.Contains(got[0].Prompt, "deploy is green") {
		t.Fatalf("the holder's reports = %+v", got)
	}
	if got := reportsFrom(t, f.server, f.conversation.ID, helper.ID); len(got) != 0 {
		t.Fatalf("the handing conversation still got %d reports", len(got))
	}
	child, err := f.server.store.GetAgentSessionSummary(ctx, helper.ID)
	if err != nil {
		t.Fatal(err)
	}
	if target := f.server.assistant.SignalTarget(ctx, child, child.ParentSessionID); target.SessionID != holder.ID {
		t.Fatalf("signal target = %+v, want the holder", target)
	}
}

// The 2026-11-20 storms: a child failed on its exhausted quota, its alert
// started its parent's turn, the parent failed the same way and alerted the
// child (the turn's sender), whose turn failed and alerted again; each
// failed turn held its messages again and the next retry carried them all
// (bundles of 5, 8, 9, ... 14 messages). A turn only Foundry's signals
// started alerts no one, and a child's alerts of one code that wait in its
// parent's inbox are one alert.
func TestQuotaFailuresDoNotStormAlerts(t *testing.T) {
	ctx := context.Background()
	quota := "API Error: Request rejected (429) · upstream account quota usage limit has been reached"

	t.Run("an alert-started turn alerts no one", func(t *testing.T) {
		f := newChildReportFixture(t)
		if _, err := f.db.CompleteAgentSession(ctx, f.parent.ID, "waiting for the child", "native-parent"); err != nil {
			t.Fatal(err)
		}
		failed := startAndFailAlertChild(t, f, quota, "model_rate_limit")
		sessionAlertReactions{f.server}.SessionChanged(ctx, sessions.Completed, sessions.Slim(failed))
		f.server.sessionService.PumpInbox(ctx)
		parent, err := f.db.GetAgentSessionSummary(ctx, f.parent.ID)
		if err != nil || !strings.HasPrefix(parent.Input.Prompt, sessionalerts.Prefix) {
			t.Fatalf("the parent's turn = %+v %v, want the child's alert", parent.Input, err)
		}
		if _, err := f.db.StartAgentSession(ctx, f.parent.ID); err != nil {
			t.Fatal(err)
		}
		parentFailed, err := f.db.FailAgentSession(ctx, f.parent.ID, quota)
		if err != nil {
			t.Fatal(err)
		}
		sessionAlertReactions{f.server}.SessionChanged(ctx, sessions.Completed, sessions.Slim(parentFailed))
		if alerts, _ := f.db.SessionAlertsForChild(ctx, f.parent.ID, 20); len(alerts) != 0 {
			t.Fatalf("the parent's failure alerted %+v", alerts)
		}
		items, _ := f.db.SessionInboxItems(ctx, f.child.ID, time.Now().Add(-time.Hour), 50)
		for _, item := range items {
			if item.SenderSessionID == f.parent.ID {
				t.Fatalf("the child got a message from its failed parent: %+v", item)
			}
		}
	})

	t.Run("repeated failures wait as one alert", func(t *testing.T) {
		// The parent is running, but its messages wait (its device does not
		// take them here, as an account that cannot reach its model would not).
		f := newChildReportFixture(t)
		for attempt := 0; attempt < 3; attempt++ {
			if attempt > 0 {
				if _, err := f.db.SendAgentSessionInput(ctx, f.child.ID, store.SendAgentSessionInput{Prompt: "try again", SentBySessionID: f.parent.ID}); err != nil {
					t.Fatal(err)
				}
				child, err := f.db.GetAgentSessionSummary(ctx, f.child.ID)
				if err != nil {
					t.Fatal(err)
				}
				f.child = child
				// Its new turn starts: the incident before it is over.
				sessionAlertReactions{f.server}.SessionChanged(ctx, sessions.Started, sessions.Slim(child))
			}
			failed := startAndFailAlertChild(t, f, quota, "model_rate_limit")
			sessionAlertReactions{f.server}.SessionChanged(ctx, sessions.Completed, sessions.Slim(failed))
			f.server.sessionService.PumpInbox(ctx)
		}
		var waiting []store.SessionInboxItem
		for _, item := range parentAlertItems(t, f) {
			if item.Pending() {
				waiting = append(waiting, item)
			}
		}
		if len(waiting) != 1 || !strings.Contains(waiting[0].Prompt, "Occurrences: 3") {
			t.Fatalf("waiting alerts = %+v, want one standing for three failures", waiting)
		}
	})
}

// A helper a workspace session ties to an item (pa_item_helpers) shows on the
// item as the assistant's helpers do: in read_list, the REST item and the
// item file, with helper_started when it joins and helper_ended when its
// session ends. It still is no task of the assistant.
func TestWorkspaceHelperShowsOnItsItem(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	orchestrator := f.startSession(t, "ws_alice", "", "track the release checklist for the launch")
	token := f.mint(t, orchestrator.ID)
	added, text, failed := f.updateItem(t, token, "add", map[string]any{"text": "Release checklist", "quote": "track the release checklist"})
	if failed {
		t.Fatalf("add: %s", text)
	}
	item := added.Item
	text, failed = f.tool(t, token, "create_session", map[string]any{"workspaceId": "ws_alice", "prompt": "walk the release checklist", "itemId": item.ID})
	var created struct {
		ID string `json:"id"`
	}
	if failed || json.Unmarshal([]byte(text), &created) != nil || created.ID == "" {
		t.Fatalf("create_session itemId: %s", text)
	}

	events := f.itemEvents(t, agent.ID, item.ID)
	if last := events[len(events)-1]; last.Kind != store.PersonalAgentItemEventHelperStarted || last.Actor != store.PersonalAgentActorSession ||
		last.Detail == nil || last.Detail.SessionID != created.ID || last.Detail.WorkspaceID != "ws_alice" {
		t.Fatalf("last event = %+v, want the helper's start", last)
	}
	read, failed := f.tool(t, token, "read_list", map[string]any{})
	var page struct {
		Items []struct {
			ID      string `json:"id"`
			Helpers []struct {
				SessionID string `json:"sessionId"`
				Status    string `json:"status"`
			} `json:"helpers"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(read), &page); failed || err != nil || len(page.Items) != 1 || len(page.Items[0].Helpers) != 1 ||
		page.Items[0].Helpers[0].SessionID != created.ID || page.Items[0].Helpers[0].Status != store.PersonalAgentTaskRunning {
		t.Fatalf("read_list = %s", read)
	}
	stored, err := f.server.store.GetPersonalAgentItem(ctx, agent.ID, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	view, err := f.server.personalAgentItemWithHelpers(ctx, agent.ID, stored)
	if err != nil || len(view.Helpers) != 1 || view.Helpers[0].SessionID != created.ID || view.Helpers[0].WorkspaceID != "ws_alice" {
		t.Fatalf("REST item = %+v (%v)", view, err)
	}
	items, helpers, err := f.server.store.ListPersonalAgentItemsAtHome(ctx, f.aliceID, "ws_alice")
	if err != nil || len(items) != 1 {
		t.Fatalf("items at home = %+v (%v)", items, err)
	}
	if file := assistant.ItemFile(items[0], helpers[item.ID], events); !strings.Contains(file, "- "+created.ID) {
		t.Fatalf("the item file lists no helper:\n%s", file)
	}
	if tasks, _ := f.server.store.ListPersonalAgentTasks(ctx, agent.ID, nil); len(tasks) != 0 {
		t.Fatalf("a workspace session's helper became the assistant's task: %+v", tasks)
	}

	ended := endTurn(t, f.server, created.ID, "The checklist has two open steps.")
	for _, observer := range f.server.assistant.Observers() {
		observer.SessionChanged(ctx, sessions.Completed, sessions.Slim(ended))
	}
	events = f.itemEvents(t, agent.ID, item.ID)
	if last := events[len(events)-1]; last.Kind != store.PersonalAgentItemEventHelperEnded || last.Actor != store.PersonalAgentActorFoundry ||
		last.Detail == nil || last.Detail.SessionID != created.ID || last.Detail.To != store.PersonalAgentTaskDone {
		t.Fatalf("last event = %+v, want the helper's end", last)
	}
	if view, err = f.server.personalAgentItemWithHelpers(ctx, agent.ID, stored); err != nil || view.Helpers[0].Status != store.PersonalAgentTaskDone || view.Helpers[0].EndedAt == "" {
		t.Fatalf("REST item after the end = %+v (%v)", view.Helpers, err)
	}
}
