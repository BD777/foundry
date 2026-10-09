package store

import (
	"path/filepath"
	"strings"
)

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

// NormalizeChatAttachments keeps the attachments a message can carry: each
// needs an id and a path, appears once, and is an image or a file.
func NormalizeChatAttachments(attachments []ChatAttachment) []ChatAttachment {
	if len(attachments) == 0 {
		return nil
	}
	result := make([]ChatAttachment, 0, len(attachments))
	seen := map[string]bool{}
	for _, attachment := range attachments {
		id := strings.TrimSpace(attachment.ID)
		path := strings.TrimSpace(attachment.Path)
		if id == "" || path == "" || seen[id] {
			continue
		}
		seen[id] = true
		name := strings.TrimSpace(attachment.Name)
		if name == "" {
			name = filepath.Base(path)
		}
		kind := strings.TrimSpace(attachment.Kind)
		if kind != "image" {
			kind = "file"
		}
		result = append(result, ChatAttachment{
			ID:       id,
			Name:     name,
			Path:     path,
			MIMEType: strings.TrimSpace(attachment.MIMEType),
			Size:     attachment.Size,
			Kind:     kind,
		})
	}
	if len(result) == 0 {
		return nil
	}
	return result
}
