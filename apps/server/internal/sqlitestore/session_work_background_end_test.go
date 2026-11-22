package sqlitestore

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessionwork"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// importStateWork imports a session's work as a read of its work list does
// (importThreadWork): from its state events.
func importStateWork(t *testing.T, db *Store, sessionID string) {
	t.Helper()
	ctx := context.Background()
	sources, err := db.SessionWorkSources(ctx, sessionID)
	if err != nil || len(sources) != 1 {
		t.Fatalf("sources: %+v %v", sources, err)
	}
	session := sources[0]
	if session.Events, err = db.AgentSessionStateEvents(ctx, sessionID, ""); err != nil {
		t.Fatal(err)
	}
	for _, item := range sessionwork.FromEvents(session) {
		if _, err := db.SaveSessionWork(ctx, item); err != nil {
			t.Fatal(err)
		}
	}
}

func endedAtIs(value string, want time.Time) bool {
	at, err := time.Parse(time.RFC3339Nano, value)
	return err == nil && at.Equal(want)
}

// A background command's end reaches the work list from its lifecycle end,
// not only from the inventory, which keeps the 20 most recent finished tasks:
// read after more than 20 others ended and after its device could no longer
// see it, it has ended as the agent reported, at its end, with its exit code.
func TestBackgroundCommandEndOutlivesTheInventory(t *testing.T) {
	for _, test := range []struct {
		name      string
		confirmed bool   // the device saw it running before it lost sight of it
		native    string // the end's native status; "" from Workers before it
		label     string
		want      string
	}{
		{name: "completed", native: "completed", label: store.ProcessLabelSubtaskCompleted, want: "completed"},
		{name: "completed after the device confirmed it running", confirmed: true, native: "completed", label: store.ProcessLabelSubtaskCompleted, want: "completed"},
		{name: "failed", native: "failed", label: store.ProcessLabelSubtaskFailed, want: "failed"},
		{name: "stopped", native: "stopped", label: store.ProcessLabelSubtaskFailed, want: "stopped"},
		{name: "completed, from an older Worker", label: store.ProcessLabelSubtaskCompleted, want: "completed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			db := newTestStore(t)
			registerAgentSessionTestDaemon(t, db, "ws_bg_end", "agent_bg_end")
			session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_bg_end", AgentID: "agent_bg_end", Provider: "codex", Prompt: "run it"})
			if err != nil {
				t.Fatal(err)
			}
			start := time.Now().UTC().Add(-time.Hour).Truncate(time.Millisecond)
			at := func(seconds int) time.Time { return start.Add(time.Duration(seconds) * time.Second) }
			save := func(event store.AgentSessionEvent, when time.Time) {
				t.Helper()
				event.SessionID, event.At = session.ID, formatTime(when)
				if event.Level == "" {
					event.Level = "info"
				}
				if err := db.saveAgentSessionEvent(ctx, event, when); err != nil {
					t.Fatal(err)
				}
			}
			snapshot := func(id string, tasks []store.AgentBackgroundTask) store.AgentSessionEvent {
				return store.AgentSessionEvent{ID: id, Label: store.ProcessLabelBackgroundTasksSync, Metadata: &store.AgentSessionEventMetadata{BackgroundTaskSnapshot: &tasks}}
			}
			save(store.AgentSessionEvent{ID: "evt_cmd_start", Label: store.ProcessLabelStartingSubtask, Detail: "Build the app", Metadata: &store.AgentSessionEventMetadata{TaskID: "bcmd", TaskType: "local_bash"}}, at(0))
			save(snapshot("evt_bg_running", []store.AgentBackgroundTask{{ID: "bcmd", Provider: "claude", Kind: "command", Description: "Build the app", Status: "running", StartedAt: formatTime(at(0))}}), at(1))

			// Someone reads the work list while it runs.
			importStateWork(t, db, session.ID)
			id := sessionwork.ID(session.ID, "claude", "bcmd")
			if test.confirmed {
				if err := db.ObserveSessionWork(ctx, id, store.WorkObservation{Status: "running", At: formatTime(at(5)), StartedAt: formatTime(at(0)), ConfirmedRevision: 1}); err != nil {
					t.Fatal(err)
				}
			}

			ended := at(10)
			end := store.AgentSessionEvent{ID: "evt_cmd_end", Label: test.label, Detail: "Build the app", Metadata: &store.AgentSessionEventMetadata{TaskID: "bcmd", TaskStatus: test.native}}
			var exitCode *int64
			if test.native != "" {
				code := int64(3)
				exitCode = &code
				end.Metadata.ExitCode = exitCode
			}
			if test.label == store.ProcessLabelSubtaskFailed {
				end.Level = "error"
			}
			save(end, ended)
			// 21 other commands end; the inventory keeps 20 finished tasks.
			var finished []store.AgentBackgroundTask
			for n := range 21 {
				task := fmt.Sprintf("bother%d", n)
				end := at(20 + n)
				save(store.AgentSessionEvent{ID: "evt_end_" + task, Label: store.ProcessLabelSubtaskCompleted, Detail: "done", Metadata: &store.AgentSessionEventMetadata{TaskID: task, TaskStatus: "completed"}}, end)
				finished = append([]store.AgentBackgroundTask{{ID: task, Provider: "claude", Kind: "command", Description: task, Status: "completed", StartedAt: formatTime(at(15)), EndedAt: formatTime(end)}}, finished...)
			}
			save(snapshot("evt_bg_latest", finished[:20]), at(45))

			// Its device can no longer see it.
			confirmed := int64(0)
			if test.confirmed {
				confirmed = 1
			}
			if err := db.ObserveSessionWork(ctx, id, store.WorkObservation{Status: "unknown", At: formatTime(at(50)), StartedAt: formatTime(at(0)), ConfirmedRevision: confirmed}); err != nil {
				t.Fatal(err)
			}

			importStateWork(t, db, session.ID)
			list, err := db.ListSessionWork(ctx, session.ID, "")
			if err != nil {
				t.Fatal(err)
			}
			for _, item := range list.Items {
				if item.ID != id {
					continue
				}
				observed := item.Observation
				exitCodeOK := (exitCode == nil && observed.ExitCode == nil) || (exitCode != nil && observed.ExitCode != nil && *observed.ExitCode == *exitCode)
				if observed.Status != test.want || !endedAtIs(observed.EndedAt, ended) || !exitCodeOK || item.Title != "Build the app" {
					t.Fatalf("background command after the inventory dropped it: title %q, %+v", item.Title, observed)
				}
				if !confirmedWorkEnded(item) {
					t.Fatalf("its end is not confirmed: %+v", observed)
				}
				return
			}
			t.Fatalf("background command missing from %+v", list.Items)
		})
	}
}

// A recorded end is final: the lifecycle end of a stopped command, which
// says failed and arrives a moment after the inventory recorded the stop,
// leaves the stop alone.
func TestRecordedBackgroundCommandEndIsFinal(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_bg_final", "agent_bg_final")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_bg_final", AgentID: "agent_bg_final", Provider: "codex", Prompt: "run it"})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now().UTC().Add(-time.Hour).Truncate(time.Millisecond)
	stoppedAt := start.Add(10 * time.Second)
	tasks := []store.AgentBackgroundTask{{ID: "bstop", Provider: "claude", Kind: "command", Description: "Benchmark", Status: "stopped", StopReason: "user", StartedAt: formatTime(start), EndedAt: formatTime(stoppedAt)}}
	for index, event := range []store.AgentSessionEvent{
		{ID: "evt_bg_stopped", Label: store.ProcessLabelBackgroundTasksSync, Metadata: &store.AgentSessionEventMetadata{BackgroundTaskSnapshot: &tasks}},
		{ID: "evt_bg_empty", Label: store.ProcessLabelBackgroundTasksSync, Metadata: &store.AgentSessionEventMetadata{BackgroundTaskSnapshot: &[]store.AgentBackgroundTask{}}},
	} {
		when := stoppedAt.Add(time.Duration(index) * time.Minute)
		event.SessionID, event.At, event.Level = session.ID, formatTime(when), "info"
		if err := db.saveAgentSessionEvent(ctx, event, when); err != nil {
			t.Fatal(err)
		}
		if index == 0 {
			importStateWork(t, db, session.ID)
			// An older Worker's end of it: a failure, a moment later.
			later := stoppedAt.Add(3 * time.Millisecond)
			end := store.AgentSessionEvent{ID: "evt_stop_end", SessionID: session.ID, Label: store.ProcessLabelSubtaskFailed, Level: "error", Detail: "Benchmark", At: formatTime(later), Metadata: &store.AgentSessionEventMetadata{TaskID: "bstop"}}
			if err := db.saveAgentSessionEvent(ctx, end, later); err != nil {
				t.Fatal(err)
			}
		}
	}
	importStateWork(t, db, session.ID)
	list, err := db.ListSessionWork(ctx, session.ID, "")
	if err != nil || len(list.Items) != 1 {
		t.Fatalf("list: %+v %v", list.Items, err)
	}
	if observed := list.Items[0].Observation; observed.Status != "stopped" || !endedAtIs(observed.EndedAt, stoppedAt) {
		t.Fatalf("the recorded stop changed: %+v", observed)
	}
}
