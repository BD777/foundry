package httpapi

import (
	"context"
	"log"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A message one session sends another names its sender on its transcript
// event (AgentSessionEventMetadata.SentBySessionID): an input's event is
// written by the store (SessionInputEvents); a message steered into a
// running turn is written by its device, and named here when it arrives.

// messageSender is the session a caller sends as: its own, for a session
// token; none for a person.
func messageSender(actor Actor) string {
	if !actor.Agent() {
		return ""
	}
	return actor.Identity.SessionID
}

// recordSteerSender keeps who steers input into sessionID before its device
// takes it, naming the input first when the caller did not: the device
// writes the message's event as evt_<input id>.
func (s *Server) recordSteerSender(ctx context.Context, sessionID string, input *store.SendAgentSessionInput) error {
	if input.SentBySessionID == "" {
		return nil
	}
	if input.InputID == "" {
		input.InputID = uuid.NewString()
	}
	return s.store.RecordSessionInputSender(ctx, sessionID, input.InputID, input.SentBySessionID)
}

// withSteerSender names the session that sent a steered message on the
// event its device reports for it. Every report of the event names the
// same sender, so one sent again stays unchanged.
func (h *DaemonHub) withSteerSender(ctx context.Context, event store.AgentSessionEvent) store.AgentSessionEvent {
	inputID, steered := strings.CutPrefix(event.ID, "evt_")
	if event.Label != steeredIntoTurnLabel || !steered || inputID == "" {
		return event
	}
	sender, err := h.store.SessionInputSender(ctx, event.SessionID, inputID)
	if err != nil {
		log.Printf("read sender of steered message %s: %v", event.ID, err)
		return event
	}
	if sender == "" {
		return event
	}
	metadata := store.AgentSessionEventMetadata{}
	if event.Metadata != nil {
		metadata = *event.Metadata
	}
	metadata.SentBySessionID = sender
	event.Metadata = &metadata
	return event
}

// handleGetSessionLink names a session for a link to it (the session that
// started a chat or sent it a message), for a caller who may view it.
func (s *Server) handleGetSessionLink(w http.ResponseWriter, r *http.Request) {
	session := guardedSession(r)
	link := store.SessionLink{ID: session.ID, WorkspaceID: session.WorkspaceID, Title: session.Title}
	chatID := session.ThreadID
	if chatID == "" {
		chatID = session.ID
	}
	// The title the person sees: a rename or an AI title wins.
	titles, err := s.store.ListChatTitles(r.Context(), session.WorkspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	for _, title := range titles {
		if title.ChatID == chatID && strings.TrimSpace(title.Title) != "" {
			link.Title = title.Title
		}
	}
	writeJSON(w, http.StatusOK, link)
}
