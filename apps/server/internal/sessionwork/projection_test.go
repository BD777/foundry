package sessionwork

import (
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
)

func TestLegacySubagentsRemainInTheUnifiedInventory(t *testing.T) {
	items := FromEvents(store.AgentSession{ID: "session", Events: []store.AgentSessionEvent{
		{Label: "正在启动子任务", Detail: "inspect", At: "2026-10-10T00:00:00Z", Metadata: &store.AgentSessionEventMetadata{TaskID: "agent_old", TaskType: "local_agent"}},
		{Label: "子任务完成", At: "2026-10-10T00:01:00Z", Metadata: &store.AgentSessionEventMetadata{TaskID: "agent_old"}},
	}})
	if len(items) != 1 || items[0].Observation.Status != "completed" || items[0].Observation.At != "2026-10-10T00:01:00Z" {
		t.Fatalf("legacy subagent disappeared: %+v", items)
	}
}
