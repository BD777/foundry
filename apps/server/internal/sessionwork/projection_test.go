package sessionwork

import (
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
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
