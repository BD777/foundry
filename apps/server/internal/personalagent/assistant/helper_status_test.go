package assistant

import (
	"context"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Both kinds of helper (the assistant's task, a session linked to the item)
// follow their session the same way: waiting for its device is queued, a
// turn that ended on an unanswered question is asking, a new input runs it
// again, and only a final status records helper_ended. Each status change
// tells the item's home; a change that keeps the status tells nothing.
func TestHelpersFollowTheirSessionOntoTheirItem(t *testing.T) {
	db, err := sqlitestore.Open(t.TempDir() + "/foundry.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	agent, err := db.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: "user_a", WorkspaceID: "ws_assistant"})
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	told := map[string]int{}
	db.ObservePersonalAgentItemChanges(func(change store.PersonalAgentItemChange) {
		mu.Lock()
		defer mu.Unlock()
		if slices.Contains(change.Workspaces, "ws_home") {
			told[change.ItemID]++
		}
	})
	take := func(itemID string) int {
		mu.Lock()
		defer mu.Unlock()
		n := told[itemID]
		told[itemID] = 0
		return n
	}
	start := time.Now().UTC()
	at := func(after time.Duration) string { return start.Add(after).Format(time.RFC3339Nano) }
	service := &Service{store: db}
	reactions := taskReactions{service}

	newItem := func(text string) store.PersonalAgentListItem {
		item, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: agent.ID, Text: text, HomeWorkspaceID: "ws_home"})
		if err != nil {
			t.Fatal(err)
		}
		return item
	}
	taskItem, linkedItem := newItem("Task helper"), newItem("Linked helper")
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_work", Label: "work", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_work", Name: "Work", LocalPath: "/home/me/work", Baseline: "main"},
		Agents: []store.AgentProjection{{ID: "agent_work", WorkspaceID: "ws_work", DeviceID: "dev_work", Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online"}},
	}); err != nil {
		t.Fatal(err)
	}
	newSession := func() store.AgentSession {
		session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_work", AgentID: "agent_work", Provider: "claude", Prompt: "help"})
		if err != nil {
			t.Fatal(err)
		}
		return session
	}
	taskSession := newSession()
	taskSession.CreatedByUserID = "user_a"
	if _, err := db.CreatePersonalAgentTask(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentTask{UserID: "user_a", AssistantID: agent.ID,
		WorkspaceID: "ws_work", SessionID: taskSession.ID, Title: "task", ItemID: taskItem.ID}); err != nil {
		t.Fatal(err)
	}
	linkedSession := newSession()
	if err := db.LinkPersonalAgentItemHelper(ctx, store.PersonalAgentActorSession, agent.ID, linkedItem.ID, linkedSession.ID); err != nil {
		t.Fatal(err)
	}

	for _, helper := range []struct {
		item    store.PersonalAgentListItem
		session store.AgentSession
	}{{taskItem, taskSession}, {linkedItem, linkedSession}} {
		session, itemID := helper.session, helper.item.ID
		take(itemID)
		status := func() store.PersonalAgentTask {
			t.Helper()
			helpers, err := db.ListPersonalAgentItemHelpers(ctx, agent.ID, itemID)
			if err != nil || len(helpers) != 1 {
				t.Fatalf("%s helpers = %+v (%v)", session.ID, helpers, err)
			}
			return helpers[0]
		}
		step := func(change sessions.Change, sessionStatus, want string, wantTold int) {
			t.Helper()
			session.Status = sessionStatus
			reactions.SessionChanged(ctx, change, session)
			if got := status(); got.Status != want {
				t.Fatalf("%s after %s %s: status %q, want %q", session.ID, sessionStatus, sessionChangeName(change), got.Status, want)
			}
			if got := take(itemID); got != wantTold {
				t.Fatalf("%s after %s: told %d times, want %d", session.ID, sessionStatus, got, wantTold)
			}
		}

		step(sessions.Started, "running", store.PersonalAgentTaskRunning, 0)
		if err := db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{ID: "evt_q_" + session.ID, SessionID: session.ID, At: at(time.Second), Label: "Question",
			Message: &store.TranscriptMessage{ID: "msg_q_" + session.ID, Kind: "assistant", Questions: []store.AgentQuestion{{Title: "Which branch?"}}}}); err != nil {
			t.Fatal(err)
		}
		step(sessions.Completed, "completed", store.PersonalAgentTaskAsking, 1)
		if ended := status().EndedAt; ended != "" {
			t.Fatalf("%s asking has ended at %q", session.ID, ended)
		}
		// The answer arrives: a new input waits for the device, then runs.
		session.Input.At = at(2 * time.Second)
		step(sessions.Queued, "queued", store.PersonalAgentTaskQueued, 1)
		step(sessions.Started, "running", store.PersonalAgentTaskRunning, 1)
		step(sessions.Resumed, "running", store.PersonalAgentTaskRunning, 0)
		step(sessions.Completed, "completed", store.PersonalAgentTaskDone, 1)
		if ended := status().EndedAt; ended == "" {
			t.Fatalf("%s done has no end", session.ID)
		}

		// A question that held the turn and lapsed unanswered waits no more.
		session.Input.At = at(3 * time.Second)
		step(sessions.Started, "running", store.PersonalAgentTaskRunning, 1)
		for _, event := range []store.AgentSessionEvent{
			{ID: "evt_q2_" + session.ID, SessionID: session.ID, At: at(4 * time.Second), Label: "Question",
				Message: &store.TranscriptMessage{ID: "msg_q2_" + session.ID, Kind: "assistant", Questions: []store.AgentQuestion{{Title: "Deploy?"}}}},
			{ID: "evt_s2_" + session.ID, SessionID: session.ID, At: at(5 * time.Second), Label: store.EventLabelQuestionSettled, Detail: "msg_q2_" + session.ID},
		} {
			if err := db.AppendAgentSessionEvent(ctx, event); err != nil {
				t.Fatal(err)
			}
		}
		step(sessions.Completed, "completed", store.PersonalAgentTaskDone, 1)

		events, err := db.ListPersonalAgentItemEvents(ctx, agent.ID, itemID)
		if err != nil {
			t.Fatal(err)
		}
		var kinds []string
		for _, event := range events {
			if event.Detail != nil && event.Detail.SessionID == session.ID {
				kinds = append(kinds, event.Kind+":"+event.Detail.To)
			}
		}
		if want := []string{"helper_started:", "helper_ended:done", "helper_ended:done"}; !slices.Equal(kinds, want) {
			t.Fatalf("%s item events = %v, want %v", session.ID, kinds, want)
		}
	}
}

func sessionChangeName(change sessions.Change) string {
	return map[sessions.Change]string{sessions.Queued: "queued", sessions.Started: "started", sessions.Resumed: "resumed", sessions.Completed: "completed"}[change]
}
