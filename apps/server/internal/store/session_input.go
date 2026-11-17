package store

import (
	"context"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// SessionInputEvents are the transcript events an input writes: a boundary
// when the runtime changed, then the user's message (a timer's prompt shows
// as the timer firing).
func SessionInputEvents(sessionID string, input SessionInput) []AgentSessionEvent {
	var events []AgentSessionEvent
	if note := strings.TrimSpace(input.ProfileTransitionNote); note != "" {
		events = append(events, AgentSessionEvent{
			ID: SessionInputEventID(input.ID) + "_transition", SessionID: sessionID, At: input.At, Label: EventLabelProfileTransition, Level: "info",
			Message: &TranscriptMessage{ID: input.ID + ":transition", At: input.At, Kind: "boundary", Text: note},
		})
	}
	message := AgentSessionEvent{
		ID: SessionInputEventID(input.ID), SessionID: sessionID, At: input.At, Label: EventLabelUserMessage, Level: "info",
		Message: &TranscriptMessage{ID: input.ID, At: input.At, Kind: "user", Text: input.Prompt, Attachments: input.Attachments, Annotations: input.Annotations},
	}
	if input.TimerFire != nil || input.SentBySessionID != "" || input.ChannelOrigin != nil {
		message.Metadata = &AgentSessionEventMetadata{
			TimerFire: input.TimerFire, SentBySessionID: input.SentBySessionID,
			ChannelOrigin: input.ChannelOrigin,
		}
	}
	// Every input says who or what started it (DEV-246), so viewers never
	// read Foundry's prompt text or markers to tell them apart.
	if message.Metadata == nil {
		message.Metadata = &AgentSessionEventMetadata{}
	}
	message.Metadata.InputSource = SessionInputSourceOf(input)
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

const (
	maxSessionInputAnnotations    = 20
	maxSessionInputAnnotationText = 2000
)

// NormalizeSessionInputAnnotations keeps the annotations a message can carry:
// each needs an id and a selected passage, and ids appear once. Long passages
// and comments are cut to their limits; the prompt text is never changed here.
func NormalizeSessionInputAnnotations(annotations []SessionInputAnnotation) []SessionInputAnnotation {
	if len(annotations) == 0 {
		return nil
	}
	result := make([]SessionInputAnnotation, 0, min(len(annotations), maxSessionInputAnnotations))
	seen := map[string]bool{}
	for _, annotation := range annotations {
		if len(result) == maxSessionInputAnnotations {
			break
		}
		id := strings.TrimSpace(annotation.ID)
		selected := truncateRunes(strings.TrimSpace(annotation.SelectedText), maxSessionInputAnnotationText)
		if id == "" || selected == "" || seen[id] {
			continue
		}
		seen[id] = true
		result = append(result, SessionInputAnnotation{
			ID:            id,
			SelectedText:  selected,
			Comment:       truncateRunes(strings.TrimSpace(annotation.Comment), maxSessionInputAnnotationText),
			SourceEventID: strings.TrimSpace(annotation.SourceEventID),
			StartOffset:   validOffset(annotation.StartOffset),
			EndOffset:     validOffset(annotation.EndOffset),
			TurnNumber:    annotation.TurnNumber,
			MessageAt:     strings.TrimSpace(annotation.MessageAt),
		})
		last := &result[len(result)-1]
		if last.StartOffset == nil || last.EndOffset == nil || *last.EndOffset < *last.StartOffset {
			last.StartOffset, last.EndOffset = nil, nil
		}
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

// validOffset keeps a non-negative character offset; a missing or negative one is dropped.
func validOffset(offset *int64) *int64 {
	if offset == nil || *offset < 0 {
		return nil
	}
	value := *offset
	return &value
}

func truncateRunes(text string, limit int) string {
	if utf8.RuneCountInString(text) <= limit {
		return text
	}
	return string([]rune(text)[:limit])
}
