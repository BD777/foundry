package store

import (
	"context"
	"path/filepath"
	"strings"
)

// SessionInputEvents are the transcript events an input writes: a boundary
// when the runtime changed, then the user's message (a timer's prompt shows
// as the timer firing).
func SessionInputEvents(sessionID string, input SessionInput) []AgentSessionEvent {
	var events []AgentSessionEvent
	if note := strings.TrimSpace(input.ProfileTransitionNote); note != "" {
		events = append(events, AgentSessionEvent{
			ID: "evt_" + input.ID + "_transition", SessionID: sessionID, At: input.At, Label: "Profile transition", Level: "info",
			Message: &TranscriptMessage{ID: input.ID + ":transition", At: input.At, Kind: "boundary", Text: note},
		})
	}
	message := AgentSessionEvent{
		ID: "evt_" + input.ID, SessionID: sessionID, At: input.At, Label: SessionInputEventLabel, Level: "info",
		Message: &TranscriptMessage{ID: input.ID, At: input.At, Kind: "user", Text: input.Prompt, Attachments: input.Attachments},
	}
	if input.TimerFire != nil || input.SentBySessionID != "" {
		message.Metadata = &AgentSessionEventMetadata{TimerFire: input.TimerFire, SentBySessionID: input.SentBySessionID}
	}
	return append(events, message)
}

// SessionInputSenderStore keeps which session sent a message steered into
// a running turn, whose event its device writes; SessionInputSender reads
// it ("" when none did).
type SessionInputSenderStore interface {
	RecordSessionInputSender(ctx context.Context, sessionID, inputID, senderSessionID string) error
	SessionInputSender(ctx context.Context, sessionID, inputID string) (string, error)
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
