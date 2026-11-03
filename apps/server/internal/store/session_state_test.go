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
