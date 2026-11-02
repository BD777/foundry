package httpapi

import (
	"cmp"
	"context"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// deviceLabel is the device's name as people know it.
func (s *Server) deviceLabel(ctx context.Context, deviceID string) string {
	return cmp.Or(s.deviceLabels(ctx)[deviceID], "Its computer")
}

// mcpSessionBrief is what a tool that started, messaged or stopped a
// session answers: which session it is and where it stands, not its record
// (read_context reads the rest). The files the call handed over and, when it
// waits for its offline device, a note saying so come with it.
type mcpSessionBrief struct {
	ID                   string                `json:"id"`
	Title                string                `json:"title,omitempty"`
	Status               string                `json:"status"`
	Source               string                `json:"source,omitempty"`
	Error                string                `json:"error,omitempty"`
	Provider             string                `json:"provider,omitempty"`
	Profile              string                `json:"profile,omitempty"`
	Model                string                `json:"model,omitempty"`
	WorkspaceID          string                `json:"workspaceId,omitempty"`
	ParentSessionID      string                `json:"parentSessionId,omitempty"`
	InputID              string                `json:"inputId,omitempty"`
	DeliveredAttachments []deliveredAttachment `json:"deliveredAttachments,omitempty"`
	WaitingForDevice     string                `json:"waitingForDevice,omitempty"`
}

func (s *Server) mcpSessionAnswer(ctx context.Context, session store.AgentSession, attachments []store.ChatAttachment) any {
	brief := mcpSessionBrief{
		ID: session.ID, Title: session.Title, Status: session.Status, Source: session.Source, Error: session.Error,
		Provider: session.Provider, Profile: session.ProfileLabel, Model: session.Model,
		WorkspaceID: session.WorkspaceID, ParentSessionID: session.ParentSessionID, InputID: session.Input.ID,
		WaitingForDevice: s.sessionService.DeviceWaitNote(ctx, session),
	}
	for _, attachment := range attachments {
		brief.DeliveredAttachments = append(brief.DeliveredAttachments, deliveredAttachment{attachment.ID, attachment.Name, attachment.Path})
	}
	return brief
}
