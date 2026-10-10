package httpapi

import (
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// subagentUpdatedEvent carries one subagent of a session as the session's
// list shows it when it starts, so viewers read the list once and then apply
// these. Without a subagent it says only that the list may have changed (a
// task of unknown type, or subagents that ended): viewers holding the list
// read it again.
const subagentUpdatedEvent = "agent_subagent_updated"

type subagentUpdate struct {
	WorkspaceID string                      `json:"workspaceId"`
	SessionID   string                      `json:"sessionId"`
	Subagent    *store.AgentSubagentSummary `json:"subagent,omitempty"`
}

// subagentEndCoalesce is how long the ends of a session's subagents gather
// before its viewers are told to read the list again: subagents launched
// together end together, and one read covers them.
var subagentEndCoalesce = 2 * time.Second

// subagentEndSignals holds the sessions whose viewers are about to be told
// that subagents ended.
type subagentEndSignals struct {
	mu      sync.Mutex
	pending map[string]bool
}

// after runs publish once subagentEndCoalesce passed since the first end
// of the session not yet announced.
func (s *subagentEndSignals) after(sessionID string, publish func()) {
	s.mu.Lock()
	if s.pending[sessionID] {
		s.mu.Unlock()
		return
	}
	if s.pending == nil {
		s.pending = map[string]bool{}
	}
	s.pending[sessionID] = true
	s.mu.Unlock()
	time.AfterFunc(subagentEndCoalesce, func() {
		s.mu.Lock()
		delete(s.pending, sessionID)
		s.mu.Unlock()
		publish()
	})
}

// publishSubagentChange tells the workspace's viewers what a session event
// changed in its subagent list. Progress sends nothing: viewers show it from
// the event itself.
func (c *daemonConnection) publishSubagentChange(workspaceID string, event store.AgentSessionEvent, change subagentChange) {
	if workspaceID == "" || change == subagentUnchanged {
		return
	}
	publish := func(subagent *store.AgentSubagentSummary) {
		c.hub.events.PublishIn(workspaceID, subagentUpdatedEvent, subagentUpdate{WorkspaceID: workspaceID, SessionID: event.SessionID, Subagent: subagent})
	}
	switch change {
	case subagentStarted:
		if subagent, ok := startedSubagent(event); ok {
			publish(&subagent)
		}
	case subagentUntypedStart:
		publish(nil)
	case subagentEnded, subagentTaskEnded:
		// What it answered is on the device only, in a list that holds every
		// subagent's prompt and answers. It is read by whoever views the
		// session (they read the list again), not on every end: on a slow
		// uplink each read of a growing list costs more, and nobody may be
		// looking.
		c.hub.subagentEnds.after(event.SessionID, func() { publish(nil) })
	}
}

// startedSubagent is the list's entry for the subagent a start event names;
// false for one its device does not list (no tool call).
func startedSubagent(event store.AgentSessionEvent) (store.AgentSubagentSummary, bool) {
	metadata := event.Metadata
	if metadata.ToolUseID == "" {
		return store.AgentSubagentSummary{}, false
	}
	// The device's title: the task's description, which workers write as
	// the detail ("Subtask started." when it has none).
	title := strings.TrimSpace(event.Detail)
	if title == "" || title == "Subtask started." {
		title = "Subagent"
	}
	return store.AgentSubagentSummary{
		Prompt:        metadata.Prompt,
		ResponseTexts: []string{},
		SessionID:     event.SessionID,
		Status:        "running",
		SubagentType:  metadata.SubagentType,
		TaskID:        metadata.TaskID,
		Title:         title,
		ToolUseID:     metadata.ToolUseID,
	}, true
}
