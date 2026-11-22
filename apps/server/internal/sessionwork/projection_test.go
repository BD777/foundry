package sessionwork

import (
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
	"time"
)

func TestSubagentsFromTheTranscriptJoinTheInventory(t *testing.T) {
	items := FromEvents(store.AgentSession{ID: "session", Events: []store.AgentSessionEvent{
		{Label: store.ProcessLabelStartingSubtask, Detail: "inspect", At: "2026-10-10T00:00:00Z", Metadata: &store.AgentSessionEventMetadata{TaskID: "agent_old", TaskType: "local_agent"}},
		{Label: store.ProcessLabelSubtaskCompleted, At: "2026-10-10T00:01:00Z", Metadata: &store.AgentSessionEventMetadata{TaskID: "agent_old"}},
	}})
	if len(items) != 1 || items[0].Observation.Status != "completed" || items[0].Observation.At != "2026-10-10T00:01:00Z" {
		t.Fatalf("subagent missing: %+v", items)
	}
}

func TestEndedNestedSubagentUsesItsTranscriptCompletion(t *testing.T) {
	endedAt := "2026-11-08T21:21:24.561+08:00"
	items := FromEvents(store.AgentSession{ID: "session", Provider: "claude", Events: []store.AgentSessionEvent{
		{Label: store.ProcessLabelStartingSubtask, Detail: "nested task", At: "2026-11-08T21:19:25.986+08:00", Metadata: &store.AgentSessionEventMetadata{TaskID: "nested", TaskType: store.SubagentTaskType}},
		{Label: store.ProcessLabelSubtaskCompleted, At: endedAt, Metadata: &store.AgentSessionEventMetadata{TaskID: "nested"}},
		{Label: "Background tasks updated", At: "2099-01-01T00:00:00Z", Metadata: &store.AgentSessionEventMetadata{BackgroundTaskSnapshot: &[]store.AgentBackgroundTask{{
			ID: "nested", Kind: "subagent", Description: "nested task", Status: "ended", StartedAt: "2026-11-08T13:19:25.986Z", EndedAt: endedAt,
		}}}},
	}})
	if len(items) != 1 || items[0].Observation.Status != "completed" || items[0].Observation.At != "2026-11-08T13:21:24.561Z" {
		t.Fatalf("nested completion was lost: %+v", items)
	}
	if at, err := time.Parse(time.RFC3339Nano, items[0].Observation.At); err != nil || at.After(time.Now()) {
		t.Fatalf("observation time is not a past instant: %q, %v", items[0].Observation.At, err)
	}
}

func TestEndedTaskWithoutOutcomeIsHistoryAtItsRecordedEnd(t *testing.T) {
	endedAt := "2026-11-08T13:21:24.561404443Z"
	items := FromEvents(store.AgentSession{ID: "session", Provider: "claude", Events: []store.AgentSessionEvent{
		{Label: "Background tasks updated", At: "2099-01-01T00:00:00Z", Metadata: &store.AgentSessionEventMetadata{BackgroundTaskSnapshot: &[]store.AgentBackgroundTask{{
			ID: "nested", Kind: "subagent", Description: "nested task", Status: "ended", StartedAt: "2026-11-08T13:19:25.986Z", EndedAt: endedAt,
		}}}},
	}})
	if len(items) != 1 || items[0].Observation.Status != "stopped" || items[0].Observation.At != endedAt || items[0].Observation.EndedAt != endedAt {
		t.Fatalf("ended task id not normalized to history: %+v", items)
	}
}

func TestRunningObservationTimeCannotBeInTheFuture(t *testing.T) {
	items := FromEvents(store.AgentSession{ID: "session", Provider: "claude", Events: []store.AgentSessionEvent{
		{Label: store.ProcessLabelStartingSubtask, Detail: "nested task", At: "2099-01-01T00:00:00Z", Metadata: &store.AgentSessionEventMetadata{TaskID: "nested", TaskType: store.SubagentTaskType}},
	}})
	if len(items) != 1 {
		t.Fatalf("subagent missing: %+v", items)
	}
	at, err := time.Parse(time.RFC3339Nano, items[0].Observation.At)
	if err != nil || at.After(time.Now()) {
		t.Fatalf("future observation persisted: %q, %v", items[0].Observation.At, err)
	}
}

// The inventory's outcome wins over the lifecycle end, which says failed for
// a stopped task, in either order; the end still fills what it lacks.
func TestInventoryOutcomeWinsOverTheLifecycleEnd(t *testing.T) {
	stopped := []store.AgentBackgroundTask{{ID: "bstop", Kind: "command", Description: "Benchmark", Status: "stopped", StartedAt: "2026-11-20T00:00:00Z", EndedAt: "2026-11-20T00:01:00Z"}}
	snapshot := store.AgentSessionEvent{Label: store.ProcessLabelBackgroundTasksSync, At: "2026-11-20T00:01:00Z", Metadata: &store.AgentSessionEventMetadata{BackgroundTaskSnapshot: &stopped}}
	code := int64(143)
	end := store.AgentSessionEvent{Label: store.ProcessLabelSubtaskFailed, Level: "error", At: "2026-11-20T00:01:00.003Z", Metadata: &store.AgentSessionEventMetadata{TaskID: "bstop", ExitCode: &code}}
	for _, events := range [][]store.AgentSessionEvent{{snapshot, end}, {end, snapshot}} {
		items := FromEvents(store.AgentSession{ID: "session", Provider: "claude", Events: events})
		if len(items) != 1 || items[0].Observation.Status != "stopped" || items[0].Observation.EndedAt != "2026-11-20T00:01:00Z" || items[0].Observation.ExitCode == nil || *items[0].Observation.ExitCode != 143 {
			t.Fatalf("%s first: %+v", events[0].Label, items)
		}
	}
}

// A background command the inventory no longer lists ends as its lifecycle
// end reports: the native status, at its time, with its exit code.
func TestLifecycleEndOfACommandTheInventoryDropped(t *testing.T) {
	code := int64(0)
	items := FromEvents(store.AgentSession{ID: "session", Provider: "claude", NativeSessionID: "native", Events: []store.AgentSessionEvent{
		{Label: store.ProcessLabelSubtaskFailed, Level: "error", Detail: "Benchmark", At: "2026-11-20T00:01:00Z", Metadata: &store.AgentSessionEventMetadata{TaskID: "bstop", TaskStatus: "stopped"}},
		{Label: store.ProcessLabelSubtaskCompleted, Detail: `Background command "Build" completed (exit code 0)`, At: "2026-11-20T00:02:00Z", Metadata: &store.AgentSessionEventMetadata{TaskID: "bdone", TaskStatus: "completed", ExitCode: &code}},
		{Label: store.ProcessLabelBackgroundTasksSync, At: "2026-11-20T00:03:00Z", Metadata: &store.AgentSessionEventMetadata{BackgroundTaskSnapshot: &[]store.AgentBackgroundTask{}}},
	}})
	byID := map[string]store.SessionWork{}
	for _, item := range items {
		byID[item.SourceID] = item
	}
	if w := byID["bstop"]; len(items) != 2 || w.Kind != "process" || w.Observation.Status != "stopped" || w.Observation.EndedAt != "2026-11-20T00:01:00Z" || w.Native == nil || w.Spec.NativeSessionID != "native" {
		t.Fatalf("stopped command: %+v", items)
	}
	if w := byID["bdone"]; w.Observation.Status != "completed" || w.Observation.ExitCode == nil || *w.Observation.ExitCode != 0 || w.Observation.At != "2026-11-20T00:02:00Z" {
		t.Fatalf("completed command: %+v", w)
	}
}
