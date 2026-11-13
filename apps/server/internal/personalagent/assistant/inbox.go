package assistant

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/run"
	"github.com/foundry-dev/foundry/apps/server/internal/redact"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// CaptureInbox keeps a message for the assistant from channel (the web),
// once per message id; DrainInbox delivers it to that assistant.
func (s *Service) CaptureInbox(ctx context.Context, agent store.PersonalAgent, channel string, input store.PersonalAgentInboxCapture) (store.PersonalAgentInboxEntry, error) {
	return s.CaptureInboxOrigin(ctx, agent, channel, input, nil)
}

// CaptureInboxOrigin is CaptureInbox for a message from a chat (origin),
// whose answer goes back there.
func (s *Service) CaptureInboxOrigin(ctx context.Context, agent store.PersonalAgent, channel string, input store.PersonalAgentInboxCapture, origin *store.PersonalAgentInboxOrigin) (store.PersonalAgentInboxEntry, error) {
	userID := agent.UserID
	if err := flow.Capture(userID, channel, input.MessageID, input.Text); err != nil {
		return store.PersonalAgentInboxEntry{}, &personalagent.Refusal{Status: http.StatusBadRequest, Err: err}
	}
	// The default assistant keeps the ids it had before there were several.
	id := flow.Key("inbox", userID, channel, input.MessageID)
	if !agent.IsDefault {
		id = flow.Key("inbox", userID, agent.ID, channel, input.MessageID)
	}
	entry, err := s.store.CapturePersonalAgentInbox(ctx, store.PersonalAgentInboxEntry{
		ID: id, UserID: userID, AssistantID: agent.ID, Channel: channel, MessageID: input.MessageID,
		Text: input.Text, InputID: flow.InputID(id),
		Origin:   origin,
		Timezone: s.PersonLocation(ctx, agent).String(),
	})
	if errors.Is(err, store.ErrIdempotencyConflict) {
		err = &personalagent.Refusal{Status: http.StatusConflict, Err: err}
	}
	return entry, err
}

// DrainInbox resumes persisted inputs after device/account
// recovery or a server restart. It does no inference itself. A stable native
// input ID and the transcript's uniqueness fence make an unknown dispatch
// reconcilable.
func (s *Service) DrainInbox(ctx context.Context) {
	s.recoverInboxResults(ctx)
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
		s.deliverInbox(runCtx, entry)
		cancel()
	}
}

// ChannelInboxPrefix starts the inbox channel of a message channel's
// conversation (DEV-203): mc:<channel id>:<conversation key>.
const ChannelInboxPrefix = "mc:"

// IsChannelInbox reports whether an inbox channel is a message channel's.
func IsChannelInbox(channel string) bool { return strings.HasPrefix(channel, ChannelInboxPrefix) }

func (s *Service) deliverInbox(ctx context.Context, entry store.PersonalAgentInboxEntry) {
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
			if err := s.store.BindPersonalAgentRunSnapshot(ctx, entry.AssistantID, id, sessionID); err != nil {
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
	agent, err := s.store.GetAssistant(ctx, entry.AssistantID)
	if err != nil || agent.UserID != entry.UserID {
		save("waiting", "assistant_unavailable", "")
		return
	}
	if agent.State == store.PersonalAgentStopped {
		save("waiting", "assistant_paused", "")
		return
	}
	if !s.devices.Connected(agent.HomeDeviceID) {
		save("waiting", "device_offline", "")
		return
	}
	workspaceSessions, err := s.store.ListAgentSessionSummaries(ctx, agent.WorkspaceID)
	if err != nil {
		save("waiting", "session_unavailable", "")
		return
	}
	previousID, _ := s.store.PersonalAgentInboxSession(ctx, entry.AssistantID, entry.Channel)
	if entry.Origin != nil {
		previousID = entry.Origin.ThreadSessionID
	}
	// A message channel's conversation (DEV-203) waits only for its own
	// session; the person's messages do not wait for channel sessions.
	channelEntry := IsChannelInbox(entry.Channel)
	channelSessions := map[string]bool{}
	if !channelEntry && s.messageChannels != nil {
		ids, err := s.messageChannels.MessageChannelSessions(ctx, agent.ID, "")
		if err != nil {
			save("waiting", "session_unavailable", "")
			return
		}
		for _, id := range ids {
			channelSessions[id] = true
		}
	}
	var previous *store.AgentSession
	var target ChannelTarget
	if channelEntry {
		if s.channelTarget == nil {
			save("waiting", "channel_workspace_unavailable", "")
			return
		}
		if target, err = s.channelTarget(ctx, entry); err != nil {
			save("waiting", "channel_workspace_unavailable", "")
			return
		}
		if connection := s.devices.Connection(agent.HomeDeviceID); connection == nil || !connection.HasCapability(store.DaemonCapabilityReadOnlyWorkspaceSessions) {
			save("waiting", "worker_update_needed", "")
			return
		}
		// The conversation's own session: it is not in the home workspace.
		if previousID != "" {
			// One from before the channel had its workspace (or that runs
			// elsewhere) is not continued: the next one starts there.
			if session, err := s.store.GetAgentSessionSummary(ctx, previousID); err == nil && session.CreatedByUserID == entry.UserID &&
				session.WorkspaceID == target.WorkspaceID && session.WorkspaceAccess == store.SessionWorkspaceAccessRead {
				if store.IsActiveSessionStatus(session.Status) {
					save("waiting", "assistant_busy", "")
					return
				}
				previous = &session
			}
		}
		workspaceSessions = nil
	}
	for _, session := range workspaceSessions {
		conversation, own := s.Conversation(ctx, session)
		if !own || conversation.ID != agent.ID || session.CreatedByUserID != entry.UserID {
			continue
		}
		if channelEntry && session.ID != previousID || channelSessions[session.ID] {
			continue
		}
		if store.IsActiveSessionStatus(session.Status) {
			save("waiting", "assistant_busy", "")
			return
		}
		if session.ID == previousID {
			copy := session
			previous = &copy
		}
	}
	var snapshot store.PersonalAgentRunSnapshot
	if channelEntry {
		snapshot, err = s.runs.PinIn(ctx, agent, entry.ID, target.WorkspaceID)
	} else {
		snapshot, err = s.runs.Pin(ctx, agent, entry.ID, "coordinator", agent.WorkspaceID)
	}
	if err == nil {
		err = s.runs.CheckPinned(ctx, snapshot)
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
		prompt, attachments, err = s.channel.PrepareAssistantInbox(ctx, entry, agent.WorkspaceID)
		if err != nil {
			save("waiting", "channel_or_attachment_unavailable", "")
			return
		}
	}
	if channelEntry {
		attachments = append(attachments, target.Attachments...)
	}
	beforeDispatch := func(ctx context.Context, _ store.AgentSession) error {
		if channelEntry {
			sessionID, err := s.store.WorkRunInputSession(ctx, entry.InputID)
			if err != nil {
				return err
			}
			return target.OnSession(ctx, sessionID)
		}
		if entry.Origin == nil {
			return nil
		}
		sessionID, err := s.store.WorkRunInputSession(ctx, entry.InputID)
		if err != nil {
			return err
		}
		return s.channel.FollowAssistantInbox(ctx, entry, agent.WorkspaceID, sessionID)
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
		s.recordInboxResult(ctx, *previous)
		session, err = s.sessions.Send(ctx, previous.ID, store.SendAgentSessionInput{
			ExecutionBudget: run.ExecutionBudget(snapshot), Prompt: prompt, Attachments: attachments, InputID: entry.InputID, RequireIdle: true,
		}, beforeDispatch)
	} else {
		input := run.SessionInput(snapshot, prompt, entry.InputID)
		input.Attachments = attachments
		if channelEntry {
			input.WorkspaceID, input.Title, input.WorkspaceAccess = target.WorkspaceID, target.Title, store.SessionWorkspaceAccessRead
		}
		if err = s.sessions.ResolveDevice(ctx, &input); err == nil {
			session, err = s.sessions.CreateAndDispatch(ctx, input, sessions.StartOptions{Reconcile: true, BeforeDispatch: beforeDispatch})
		}
	}
	if session.ID != "" {
		save("delivered", "", session.ID)
	} else if err != nil {
		// An unknown outcome is retried only after the stable-input lookup.
		save("waiting", "dispatch_unavailable", "")
	}
}

type inboxReactions struct{ s *Service }

func (r inboxReactions) SessionChanged(ctx context.Context, change sessions.Change, session store.AgentSession) {
	if change == sessions.Completed {
		r.s.recordInboxResult(ctx, session)
	}
}

// A result belongs to one input, not to whichever turn a session runs later.
// "resolved" means this input got an answer; it never completes a TODO.
func (s *Service) recordInboxResult(ctx context.Context, session store.AgentSession) {
	agent, err := s.store.AssistantForSession(ctx, session.ID)
	if err != nil || agent.UserID != session.CreatedByUserID {
		return
	}
	entry, err := s.store.PersonalAgentInboxByInput(ctx, agent.ID, session.Input.ID)
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

func (s *Service) recoverInboxResults(ctx context.Context) {
	entries, err := s.store.UnresolvedPersonalAgentInboxResults(ctx, 100)
	if err != nil {
		return
	}
	for _, entry := range entries {
		session, err := s.store.GetAgentSessionSummary(ctx, entry.SessionID)
		if err == nil && session.CreatedByUserID == entry.UserID && session.Input.ID == entry.InputID {
			s.recordInboxResult(ctx, session)
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
		err = s.channel.DeliverAssistantInboxResult(ctx, entry, session.WorkspaceID, s.SessionURL(session))
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

// RetryInbox asks for one more delivery of the person's inbox entry
// entryID, as a new entry that keeps its source (input.RequestID once).
func (s *Service) RetryInbox(ctx context.Context, agent store.PersonalAgent, entryID string, input store.PersonalAgentInboxAction) (store.PersonalAgentInboxEntry, error) {
	userID := agent.UserID
	if input.Action != "retry" || input.RequestID == "" || len(input.RequestID) > 100 || input.Revision < 1 {
		return store.PersonalAgentInboxEntry{}, &personalagent.Refusal{Status: http.StatusBadRequest, Err: errors.New("retry requires requestId and the current revision")}
	}
	id := flow.Key("inbox", userID, "retry", entryID, input.RequestID)
	entry, err := s.store.RetryPersonalAgentInbox(ctx, agent.ID, entryID, input.Revision, store.PersonalAgentInboxEntry{
		ID: id, InputID: flow.InputID(id), MessageID: "retry:" + id,
	})
	if err != nil {
		err = &personalagent.Refusal{Status: http.StatusConflict, Err: err}
	}
	return entry, err
}
