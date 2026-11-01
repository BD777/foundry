package httpapi

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/redact"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type assistantInboxReactions struct{ s *Server }

func (r assistantInboxReactions) sessionChanged(ctx context.Context, change sessionChange, session store.AgentSession) {
	if change == sessionCompleted {
		r.s.recordAssistantInboxResult(ctx, session)
	}
}

// A result belongs to one input, not to whichever turn a session runs later.
// "resolved" means this input got an answer; it never completes a TODO.
func (s *Server) recordAssistantInboxResult(ctx context.Context, session store.AgentSession) {
	entry, err := s.store.PersonalAgentInboxByInput(ctx, session.CreatedByUserID, session.Input.ID)
	if err != nil || entry.Status == "cancelled" || entry.ResultStatus != "" {
		return
	}
	if session.Status != "completed" && session.Status != "failed" && session.Status != "canceled" {
		return
	}
	entry.SessionID, entry.ResultStatus = session.ID, session.Status
	entry.ResultText, entry.ResultError = session.Response, redact.Text(session.Error)
	if len(entry.ResultText) > 128*1024 {
		entry.ResultText = strings.ToValidUTF8(entry.ResultText[:128*1024], "")
		entry.ResultTruncated = true
	}
	entry.Status, entry.WaitingReason = "resolved", ""
	if session.Status != "completed" {
		entry.Status, entry.WaitingReason = "delivered", "execution_failed"
	}
	entry.LeaseUntil = ""
	entry.NotificationPending = entry.Origin != nil
	if _, err := s.store.SavePersonalAgentInbox(ctx, entry); err != nil && !errors.Is(err, store.ErrPersonalAgentRevision) {
		log.Printf("personal agent inbox %s: record answer: %v", entry.ID, err)
	}
}

func (s *Server) recoverAssistantInboxResults(ctx context.Context) {
	entries, err := s.store.UnresolvedPersonalAgentInboxResults(ctx, 100)
	if err != nil {
		return
	}
	for _, entry := range entries {
		session, err := s.store.GetAgentSessionSummary(ctx, entry.SessionID)
		if err == nil && session.CreatedByUserID == entry.UserID && session.Input.ID == entry.InputID {
			s.recordAssistantInboxResult(ctx, session)
		}
	}
	notifications, err := s.store.PendingPersonalAgentInboxNotifications(ctx, time.Now().UTC().Format(time.RFC3339Nano), 20)
	if err != nil {
		return
	}
	for _, entry := range notifications {
		session, err := s.store.GetAgentSessionSummary(ctx, entry.SessionID)
		if err != nil || session.CreatedByUserID != entry.UserID {
			continue
		}
		// Source card binding is checked again by the channel. A changed
		// pairing must not receive an old private result.
		err = s.feishu.DeliverAssistantInboxResult(ctx, entry, session.WorkspaceID, s.sessionURL(session))
		entry.LeaseUntil = ""
		if err == nil {
			entry.NotificationPending = false
			if entry.WaitingReason == "channel_delivery_unavailable" {
				entry.WaitingReason = ""
			}
		} else {
			entry.WaitingReason = "channel_delivery_unavailable"
			entry.LeaseUntil = time.Now().Add(30 * time.Second).UTC().Format(time.RFC3339Nano)
		}
		_, _ = s.store.SavePersonalAgentInbox(ctx, entry)
	}
}

func (s *Server) handlePersonalAgentInboxAction(w http.ResponseWriter, r *http.Request) {
	var input store.PersonalAgentInboxAction
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if input.Action != "retry" || input.RequestID == "" || len(input.RequestID) > 100 || input.Revision < 1 {
		writeError(w, http.StatusBadRequest, "retry requires requestId and the current revision")
		return
	}
	userID := s.personFrom(r).ID
	id := flow.Key("inbox", userID, "retry", r.PathValue("id"), input.RequestID)
	entry, err := s.store.RetryPersonalAgentInbox(r.Context(), userID, r.PathValue("id"), input.Revision, store.PersonalAgentInboxEntry{
		ID: id, InputID: flow.InputID(id), MessageID: "retry:" + id,
	})
	if err != nil {
		err = &statusError{http.StatusConflict, err}
	}
	writeResultWithStatus(w, http.StatusAccepted, entry, err)
}
