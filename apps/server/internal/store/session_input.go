package store

import "strings"

// SessionInputEvents are the transcript events an input writes: a boundary
// when the runtime changed, then the user's message.
func SessionInputEvents(sessionID string, input SessionInput) []AgentSessionEvent {
	var events []AgentSessionEvent
	if note := strings.TrimSpace(input.ProfileTransitionNote); note != "" {
		events = append(events, AgentSessionEvent{
			ID: "evt_" + input.ID + "_transition", SessionID: sessionID, At: input.At, Label: "Profile transition", Level: "info",
			Message: &TranscriptMessage{ID: input.ID + ":transition", At: input.At, Kind: "boundary", Text: note},
		})
	}
	return append(events, AgentSessionEvent{
		ID: "evt_" + input.ID, SessionID: sessionID, At: input.At, Label: SessionInputEventLabel, Level: "info",
		Message: &TranscriptMessage{ID: input.ID, At: input.At, Kind: "user", Text: input.Prompt, Attachments: input.Attachments},
	})
}
