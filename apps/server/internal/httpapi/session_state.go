package httpapi

import (
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// panelStateEvents are the state events before a window (see
// store.SessionStateStore) that the side panel still reads beside it, cut
// to what it reads: one the window replaces is left out, as is a fire of a
// timer the newest snapshot no longer lists (its turn's usage stays).
func panelStateEvents(older, window []store.AgentSessionEvent) []store.AgentSessionEvent {
	replaced := map[string]bool{}
	var timers *[]store.AgentScheduledTask
	for _, event := range window {
		if key := store.SessionStateKey(event); store.SessionStateLatest(key) {
			replaced[key] = true
		}
		if event.Metadata != nil && event.Metadata.TimerSnapshot != nil {
			timers = event.Metadata.TimerSnapshot
		}
	}
	if timers == nil {
		for _, event := range older {
			if event.Metadata != nil && event.Metadata.TimerSnapshot != nil {
				timers = event.Metadata.TimerSnapshot
			}
		}
	}
	live := map[string]bool{}
	if timers != nil {
		for _, task := range *timers {
			live[task.ID] = true
		}
	}
	events := make([]store.AgentSessionEvent, 0, len(older))
	for _, event := range older {
		key := store.SessionStateKey(event)
		if replaced[key] {
			continue
		}
		if event.Metadata != nil && event.Metadata.TimerFire != nil && !live[event.Metadata.TimerFire.ID] {
			if event.Metadata.TurnUsage == nil {
				continue
			}
			state := panelStateEvent(event, key)
			state.Metadata.TimerFire = nil
			events = append(events, state)
			continue
		}
		events = append(events, panelStateEvent(event, key))
	}
	return events
}

// panelStateEvent is the event with what the panel reads of it. Answers
// stay with the transcript: a subagent's progress and end carry its reply
// as their detail, a timer fire its turn's answer.
func panelStateEvent(event store.AgentSessionEvent, key string) store.AgentSessionEvent {
	state := store.AgentSessionEvent{ID: event.ID, SessionID: event.SessionID, At: event.At, Label: event.Label, Level: event.Level}
	// A subagent's title, a loaded workspace's path, a run's preview address.
	for _, named := range []string{store.SessionStateSubagent, store.SessionStateSource, store.SessionStatePreview} {
		if strings.HasPrefix(key, named) {
			state.Detail = event.Detail
		}
	}
	metadata := event.Metadata
	if metadata == nil {
		return state
	}
	state.Metadata = &store.AgentSessionEventMetadata{
		TimerSnapshot:          metadata.TimerSnapshot,
		BackgroundTaskSnapshot: metadata.BackgroundTaskSnapshot,
		SessionFile:            metadata.SessionFile,
		TaskID:                 metadata.TaskID,
		TaskType:               metadata.TaskType,
		ToolUseID:              metadata.ToolUseID,
		SubagentUsage:          metadata.SubagentUsage,
		TurnUsage:              metadata.TurnUsage,
		RequestUsage:           metadata.RequestUsage,
		ContextUsage:           metadata.ContextUsage,
	}
	if fire := metadata.TimerFire; fire != nil {
		state.Metadata.TimerFire = &store.AgentSessionTimerFire{ID: fire.ID, Origin: fire.Origin, StartedAt: fire.StartedAt, CompletedAt: fire.CompletedAt}
	}
	return state
}
