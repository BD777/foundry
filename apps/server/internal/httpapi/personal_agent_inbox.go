package httpapi

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) captureAssistantInbox(ctx context.Context, userID, channel string, input store.PersonalAgentInboxCapture) (store.PersonalAgentInboxEntry, error) {
	return s.captureAssistantInboxOrigin(ctx, userID, channel, input, nil)
}

func (s *Server) captureAssistantInboxOrigin(ctx context.Context, userID, channel string, input store.PersonalAgentInboxCapture, origin *store.PersonalAgentInboxOrigin) (store.PersonalAgentInboxEntry, error) {
	if err := flow.Capture(userID, channel, input.MessageID, input.Text); err != nil {
		return store.PersonalAgentInboxEntry{}, &statusError{http.StatusBadRequest, err}
	}
	agent, err := s.store.GetPersonalAgent(ctx, userID)
	if err != nil {
		return store.PersonalAgentInboxEntry{}, err
	}
	id := flow.Key("inbox", userID, channel, input.MessageID)
	entry, err := s.store.CapturePersonalAgentInbox(ctx, store.PersonalAgentInboxEntry{
		ID: id, UserID: userID, Channel: channel, MessageID: input.MessageID,
		Text: input.Text, InputID: flow.InputID(id),
		Origin:   origin,
		Timezone: s.personLocation(ctx, agent).String(),
	})
	if errors.Is(err, store.ErrIdempotencyConflict) {
		err = &statusError{http.StatusConflict, err}
	}
	return entry, err
}

func (s *Server) handleCapturePersonalAgentInbox(w http.ResponseWriter, r *http.Request) {
	var input store.PersonalAgentInboxCapture
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	entry, err := s.captureAssistantInbox(r.Context(), s.personFrom(r).ID, "web", input)
	writeResultWithStatus(w, http.StatusAccepted, entry, err)
}

func (s *Server) handleListPersonalAgentInbox(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListPersonalAgentInbox(r.Context(), s.personFrom(r).ID, 200)
	writeResult(w, items, err)
}

// drainPersonalAgentInbox resumes persisted inputs after device/account
// recovery or a server restart. It does no inference itself. A stable native
// input ID and the transcript's uniqueness fence make an unknown dispatch
// reconcilable.
func (s *Server) drainPersonalAgentInbox(ctx context.Context) {
	s.recoverAssistantInboxResults(ctx)
	entries, err := s.store.DuePersonalAgentInbox(ctx, time.Now().UTC().Format(time.RFC3339Nano), 20)
	if err != nil {
		log.Printf("personal agent inbox: list due: %v", err)
		return
	}
	for _, entry := range entries {
		if ctx.Err() != nil {
			return
		}
		runCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		s.deliverAssistantInbox(runCtx, entry)
		cancel()
	}
}

func (s *Server) deliverAssistantInbox(ctx context.Context, entry store.PersonalAgentInboxEntry) {
	entry.Status, entry.LeaseUntil = "dispatching", time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
	claimed, err := s.store.SavePersonalAgentInbox(ctx, entry)
	if err != nil {
		return // another dispatcher or a user action owns the new revision
	}
	entry = claimed
	save := func(status, reason, sessionID string) {
		entry.Status, entry.WaitingReason, entry.SessionID = status, reason, sessionID
		entry.LeaseUntil = ""
		if status == "waiting" {
			entry.LeaseUntil = time.Now().Add(10 * time.Second).UTC().Format(time.RFC3339Nano)
		}
		if _, err := s.store.SavePersonalAgentInbox(ctx, entry); err != nil {
			log.Printf("personal agent inbox %s: save receipt: %v", entry.ID, err)
		}
		if status == "delivered" {
			id := flow.Key("parun", entry.UserID, entry.ID)
			if err := s.store.BindPersonalAgentRunSnapshot(ctx, entry.UserID, id, sessionID); err != nil {
				log.Printf("personal agent inbox %s: bind run snapshot: %v", entry.ID, err)
			}
		}
	}
	// Reconcile BEFORE considering a new attempt. A crash can occur after
	// CreateAgentSession commits its input but before this receipt is saved.
	if sessionID, err := s.store.WorkRunInputSession(ctx, entry.InputID); err == nil {
		session, readErr := s.store.GetAgentSessionSummary(ctx, sessionID)
		if readErr == nil && session.CreatedByUserID == entry.UserID {
			save("delivered", "", sessionID)
		} else {
			save("waiting", "receipt_unavailable", "")
		}
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		save("waiting", "receipt_unavailable", "")
		return
	}
	agent, err := s.store.GetPersonalAgent(ctx, entry.UserID)
	if err != nil {
		save("waiting", "assistant_unavailable", "")
		return
	}
	if agent.State == store.PersonalAgentStopped {
		save("waiting", "assistant_paused", "")
		return
	}
	if !s.hub.HasConnection(agent.HomeDeviceID) {
		save("waiting", "device_offline", "")
		return
	}
	connection := s.hub.connectionFor(agent.HomeDeviceID)
	if connection == nil || !connection.hasCapability("role_run_budgets_v1") || !connection.hasCapability("exact_input_cancel_v1") {
		save("waiting", "worker_update_required", "")
		return
	}
	sessions, err := s.store.ListAgentSessionSummaries(ctx, agent.WorkspaceID)
	if err != nil {
		save("waiting", "session_unavailable", "")
		return
	}
	previousID, _ := s.store.PersonalAgentInboxSession(ctx, entry.UserID, entry.Channel)
	if entry.Origin != nil {
		previousID = entry.Origin.ThreadSessionID
	}
	var previous *store.AgentSession
	for _, session := range sessions {
		if _, own := s.assistantConversation(ctx, session); !own || session.CreatedByUserID != entry.UserID {
			continue
		}
		if activeOrBlocked(session.Status) {
			save("waiting", "assistant_busy", "")
			return
		}
		if session.ID == previousID {
			copy := session
			previous = &copy
		}
	}
	snapshot, err := s.pinAssistantRun(ctx, agent, entry.ID, "coordinator", agent.WorkspaceID)
	if err == nil {
		err = s.checkPinnedAssistantRun(ctx, snapshot)
	}
	if err != nil {
		reason := "account_unavailable"
		switch {
		case strings.Contains(err.Error(), "role is disabled"):
			reason = "role_disabled"
		case strings.Contains(err.Error(), "location"):
			reason = "execution_location_mismatch"
		case strings.Contains(err.Error(), "model_unavailable"):
			reason = "model_unavailable"
		case strings.Contains(err.Error(), "effort"):
			reason = "effort_unavailable"
		case strings.Contains(err.Error(), "permission"):
			reason = "permission_required"
		}
		save("waiting", reason, "")
		return
	}
	prompt, attachments := entry.Text, []store.ChatAttachment(nil)
	if entry.Origin != nil {
		prompt, attachments, err = s.feishu.PrepareAssistantInbox(ctx, entry, agent.WorkspaceID)
		if err != nil {
			save("waiting", "channel_or_attachment_unavailable", "")
			return
		}
	}
	beforeDispatch := func(ctx context.Context) error {
		if entry.Origin == nil {
			return nil
		}
		sessionID, err := s.store.WorkRunInputSession(ctx, entry.InputID)
		if err != nil {
			return err
		}
		return s.feishu.FollowAssistantInbox(ctx, entry, agent.WorkspaceID, sessionID)
	}
	var session store.AgentSession
	previousEffort := ""
	if previous != nil {
		if snapshot.Runtime == "codex" {
			previousEffort = previous.CodexReasoningEffort
		} else {
			previousEffort = previous.ClaudeEffort
		}
	}
	if previous != nil && previous.Status == "completed" && previous.ProfileID == snapshot.ProfileID &&
		previous.Provider == snapshot.Runtime && previous.Model == snapshot.Model && previousEffort == snapshot.Effort {
		s.recordAssistantInboxResult(ctx, *previous)
		session, err = s.sendSessionMessageWith(ctx, previous.ID, store.SendAgentSessionInput{
			ExecutionBudget: runExecutionBudget(snapshot), Prompt: prompt, Attachments: attachments, InputID: entry.InputID, RequireIdle: true,
		}, beforeDispatch)
	} else {
		input := runSessionInput(snapshot, prompt, entry.InputID)
		input.Attachments = attachments
		if err = s.resolveSessionDevice(ctx, &input); err == nil {
			session, err = s.createAndDispatchWith(ctx, input, true, beforeDispatch)
		}
	}
	if session.ID != "" {
		save("delivered", "", session.ID)
	} else if err != nil {
		// An unknown outcome is retried only after the stable-input lookup.
		save("waiting", "dispatch_unavailable", "")
	}
}
