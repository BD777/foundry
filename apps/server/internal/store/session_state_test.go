package store

import "testing"

// A turn's end that names a local URL keeps it as a preview, whichever
// runtime ended the turn; Codex's label is "Codex finished".
func TestTurnEndNamingALocalURLIsAPreview(t *testing.T) {
	for _, label := range []string{EventLabelClaudeTurnEnd, EventLabelCodexTurnEnd, EventLabelProfileCommandTurnEnd} {
		event := AgentSessionEvent{ID: "evt_end", Label: label, Level: "info", Detail: "Ready at http://127.0.0.1:4173/",
			Metadata: &AgentSessionEventMetadata{TurnUsage: &AgentTurnUsage{InputTokens: 1}}}
		if got := SessionStateKey(event); got != SessionStatePreview+"evt_end" {
			t.Errorf("%s: key = %q", label, got)
		}
	}
	if got := SessionStateKey(AgentSessionEvent{ID: "evt_x", Label: EventLabelResponseStream, Level: "info", Detail: "http://127.0.0.1:4173/"}); got != "" {
		t.Errorf("answer key = %q", got)
	}
}

func TestSubtaskEventsAreLifecycleEventsWithATask(t *testing.T) {
	task := &AgentSessionEventMetadata{TaskID: "task_1"}
	for _, test := range []struct {
		event AgentSessionEvent
		want  SubtaskPhase
	}{
		{AgentSessionEvent{Label: ProcessLabelSubtaskRunning, Metadata: task}, SubtaskProgressed},
		{AgentSessionEvent{Label: ProcessLabelStartingSubtask, Metadata: task}, SubtaskStarted},
		{AgentSessionEvent{Label: ProcessLabelSubtaskCompleted, Metadata: task}, SubtaskCompleted},
		{AgentSessionEvent{Label: ProcessLabelSubtaskFailed, Metadata: task}, SubtaskFailed},
		{AgentSessionEvent{Label: EventLabelResponseStream, Metadata: task}, NotSubtask},
		{AgentSessionEvent{Label: ProcessLabelSubtaskRunning}, NotSubtask},
	} {
		if got := SubtaskEventPhase(test.event); got != test.want {
			t.Errorf("SubtaskEventPhase(%+v) = %v, want %v", test.event, got, test.want)
		}
	}
}
