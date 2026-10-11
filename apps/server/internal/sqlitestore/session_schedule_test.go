package sqlitestore

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A session keeps the timers its agent holds from the device's snapshots,
// whatever its latest input's status, and a timer's prompt sent as its next
// input shows as the timer firing.
func TestTimerSnapshotsKeepTheSessionScheduleAndTimerInputsShowAsFires(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_t", "agent_t")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_t", AgentID: "agent_t", Provider: "codex", Prompt: "inspect every 30 minutes"})
	if err != nil {
		t.Fatal(err)
	}
	snapshot := func(id string, tasks []store.AgentScheduledTask) {
		t.Helper()
		if err := db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{
			ID: id, SessionID: session.ID, Label: "Scheduled tasks updated", Level: "info",
			Metadata: &store.AgentSessionEventMetadata{TimerSnapshot: &tasks},
		}); err != nil {
			t.Fatal(err)
		}
	}
	snapshot("evt_timers_1", []store.AgentScheduledTask{{
		ID: "9b17c9d2", Kind: "cron", Schedule: "28,58 * * * *", Recurring: true, Prompt: "巡检", NextFireAt: "2026-10-11T02:37:05Z",
	}})
	if _, err := db.CompleteAgentSession(ctx, session.ID, "scheduled", "native_t"); err != nil {
		t.Fatal(err)
	}
	completed, err := db.GetAgentSessionSummary(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != "completed" || completed.Scheduled == nil || len(completed.Scheduled.Timers) != 1 ||
		completed.Scheduled.Timers[0].Schedule != "28,58 * * * *" || completed.Scheduled.ReportedAt == "" {
		t.Fatalf("completed session = %s %+v", completed.Status, completed.Scheduled)
	}

	fire := &store.AgentSessionTimerFire{ID: "9b17c9d2", Origin: "scheduled", Prompt: "巡检"}
	sent, err := db.SendAgentSessionInput(ctx, session.ID, store.SendAgentSessionInput{Prompt: "巡检", TimerFire: fire})
	if err != nil {
		t.Fatal(err)
	}
	if sent.Input.TimerFire == nil || sent.Input.TimerFire.ID != "9b17c9d2" || sent.Scheduled == nil {
		t.Fatalf("timer input = %+v, schedule %+v", sent.Input, sent.Scheduled)
	}
	full, err := db.GetAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	var shown bool
	for _, event := range full.Events {
		if event.ID == "evt_"+sent.Input.ID {
			shown = event.Metadata != nil && event.Metadata.TimerFire != nil && event.Metadata.TimerFire.ID == "9b17c9d2" &&
				event.Message != nil && event.Message.Text == "巡检"
		}
	}
	if !shown {
		t.Fatal("the timer's input event does not show the timer firing")
	}

	snapshot("evt_timers_2", []store.AgentScheduledTask{})
	cleared, err := db.GetAgentSessionSummary(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if cleared.Scheduled != nil {
		t.Fatalf("after CronDelete the session still holds %+v", cleared.Scheduled)
	}
}
