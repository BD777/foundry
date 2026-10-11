package httpapi

import (
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// startedSubagent is the list's entry for the subagent a start event names;
// false for one its device does not list (no tool call).
func startedSubagent(event store.AgentSessionEvent) (store.AgentSubagentDigest, bool) {
	metadata := event.Metadata
	if metadata.ToolUseID == "" {
		return store.AgentSubagentDigest{}, false
	}
	// The device's title: the task's description, which workers write as
	// the detail ("Subtask started." when it has none).
	title := strings.TrimSpace(event.Detail)
	if title == "" || title == "Subtask started." {
		title = "Subagent"
	}
	return store.AgentSubagentDigest{
		ResponseFingerprints: []string{},
		SessionID:            event.SessionID,
		Status:               "running",
		SubagentType:         metadata.SubagentType,
		TaskID:               metadata.TaskID,
		Title:                title,
		ToolUseID:            metadata.ToolUseID,
	}, true
}
