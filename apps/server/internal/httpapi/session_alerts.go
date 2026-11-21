package httpapi

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/modelpool"
	"github.com/foundry-dev/foundry/apps/server/internal/sessionalerts"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const sessionAlertPumpInterval = 5 * time.Second

// sessionAlertReactions adapts the session alert module to the server's
// session changes, transcript events and inbox delivery.
type sessionAlertReactions struct{ s *Server }

func (r sessionAlertReactions) SessionChanged(ctx context.Context, change sessions.Change, session store.AgentSession) {
	r.s.sessionAlerts.SessionChanged(ctx, change, session)
}

func (r sessionAlertReactions) SessionEventRecorded(ctx context.Context, event store.AgentSessionEvent) {
	r.s.sessionAlerts.SessionEventRecorded(ctx, event)
}

func newSessionAlerts(s *Server) *sessionalerts.Service {
	return sessionalerts.New(sessionalerts.Options{
		Alerts:      s.store,
		LoadSession: s.store.GetAgentSessionSummary,
		Initiator:   s.sessionAlertInitiator,
		Recipient:   s.sessionAlertRecipient,
		FailureCode: s.sessionAlertFailureCode,
		CanceledBy:  s.sessionAlertCanceledBy,
		DeviceOffline: func(_ context.Context, session store.AgentSession) bool {
			return s.sessionService.WaitsForDevice(session)
		},
		RetryPending: s.automaticSessionRetryPending,
		Deliver:      s.deliverSessionAlert,
	})
}

// sessionAlertInitiator is who hears of the session's incidents: the session
// whose message started its turn, unless only Foundry's own messages did
// (reports, alerts, relayed questions). Those carry a child's signal up to
// the one that follows it; the turn they start answers to no one who sent it
// work, and alerting their sender would send an alert back down, where its
// turn can fail and alert again (the 2026-11-20 storm, DEV-324).
func (s *Server) sessionAlertInitiator(ctx context.Context, session store.AgentSession) (string, error) {
	initiator, err := s.sessionService.TurnInitiator(ctx, session)
	if err != nil || initiator == "" {
		return initiator, err
	}
	if s.foundryStartedTurn(ctx, session) {
		return "", nil
	}
	return initiator, nil
}

// foundryStartedTurn reports whether only Foundry's own messages started the
// session's current turn.
func (s *Server) foundryStartedTurn(ctx context.Context, session store.AgentSession) bool {
	if session.Input.ID == "" {
		return false
	}
	// One message starts the turn as it was sent, before its inbox entry
	// records which turn it started.
	if sessions.FoundrySignal(session.Input.Prompt) {
		return true
	}
	since := time.Now().Add(-24 * time.Hour)
	if started, err := time.Parse(time.RFC3339Nano, session.Input.At); err == nil {
		since = started.Add(-time.Hour)
	}
	items, err := s.store.SessionInboxItems(ctx, session.ID, since, 200)
	if err != nil {
		return false
	}
	carried := 0
	for _, item := range items {
		if item.DeliveredAs != "turn" || item.DeliveredInputID != session.Input.ID {
			continue
		}
		if !sessions.FoundrySignal(item.Prompt) {
			return false
		}
		carried++
	}
	return carried > 0
}

// sessionAlertRecipient is where an alert goes when it is delivered: for a
// child on an item, whoever follows the item (assistant.SignalTarget), the
// alert waiting on the item while no one does; otherwise the recorded
// initiator.
func (s *Server) sessionAlertRecipient(ctx context.Context, alert store.SessionAlert, child store.AgentSession) (store.AgentSession, error) {
	// A wait observed as the turn started may be told only later, once the
	// messages that started it say whose they were.
	if s.foundryStartedTurn(ctx, child) {
		return store.AgentSession{}, sessionalerts.ErrDeliveryDropped
	}
	target := s.assistant.SignalTarget(ctx, child, alert.RecipientSessionID)
	if target.ItemID == "" {
		return s.store.GetAgentSessionSummary(ctx, alert.RecipientSessionID)
	}
	if target.Queued() {
		s.queueItemSignal(ctx, target, store.SessionInboxItem{
			InputID: alert.ID, SenderSessionID: child.ID, Prompt: sessionalerts.AlertText(alert, child),
			RequestedDelivery: store.DeliveryBoundary,
		}, alertMergeKey(child.ID, alert.Code))
		return store.AgentSession{}, sessionalerts.ErrDeliveryQueued
	}
	s.sendWaitingItemSignals(ctx, target)
	return s.store.GetAgentSessionSummary(ctx, target.SessionID)
}

// alertMergeKey makes the alerts of one child and code that wait together
// one.
func alertMergeKey(childID, code string) string { return "alert:" + childID + ":" + code }

func (s *Server) automaticSessionRetryPending(ctx context.Context, session store.AgentSession, code string) bool {
	return s.sessionRetries.Pending(ctx, session, code)
}

func (s *Server) sessionAlertFailureCode(ctx context.Context, child store.AgentSession) string {
	events, _, err := s.store.AgentSessionEventWindow(ctx, child.ID, "", 50)
	if err != nil {
		return ""
	}
	for _, event := range events {
		if event.Metadata == nil || event.Metadata.WorkerFailure == nil {
			continue
		}
		failure := event.Metadata.WorkerFailure
		if failure.InputID != "" && child.Input.ID != "" && failure.InputID != child.Input.ID {
			continue
		}
		code := sessionalerts.SafeCode(string(failure.Code))
		if modelpool.QuotaExhausted(code, event.Detail) {
			// Older workers classified every model 429 as model_rate_limit.
			// The provider's explicit quota text is still authoritative.
			return sessionalerts.CodeModelQuotaExhausted
		}
		return code
	}
	return ""
}

func (s *Server) sessionAlertCanceledBy(ctx context.Context, child store.AgentSession) (string, bool) {
	if strings.TrimSpace(child.Error) == "Canceled by user" {
		return "", true
	}
	events, _, err := s.store.AgentSessionEventWindow(ctx, child.ID, "", 50)
	if err != nil {
		return "", false
	}
	for _, event := range events {
		if event.Label != "Canceled by orchestrator" && event.Label != "Stopped by orchestrator" {
			continue
		}
		if event.Metadata != nil && strings.TrimSpace(event.Metadata.TaskID) != "" {
			return event.Metadata.TaskID, true
		}
		if strings.TrimSpace(event.Detail) != "" {
			return strings.TrimSpace(event.Detail), true
		}
	}
	return "", false
}

func (s *Server) deliverSessionAlert(ctx context.Context, alert store.SessionAlert, child, recipient store.AgentSession, delivery string) error {
	alert.Occurrences += s.mergeHeldAlerts(ctx, alert, child, recipient.ID)
	item := store.SessionInboxItem{
		SessionID:         recipient.ID,
		InputID:           alert.ID,
		SenderSessionID:   child.ID,
		Prompt:            sessionalerts.AlertText(alert, child),
		RequestedDelivery: delivery,
	}
	admission, err := s.store.AdmitSessionInboxItem(ctx, item, store.SessionInboxRules{Now: time.Now().UTC()})
	if err != nil {
		return fmt.Errorf("admit session alert: %w", err)
	}
	if !admission.Duplicate {
		sessions.LogInboxItem("admitted", admission.Item)
		s.sessionService.WakeInbox()
	}
	return nil
}

// mergeHeldAlerts settles the alerts of the same child and code that still
// wait in the recipient's inbox: the new alert stands for them, so a
// recipient that cannot take messages for a while gets one alert per child
// and code, not one per failure. It returns how many occurrences they
// carried.
func (s *Server) mergeHeldAlerts(ctx context.Context, alert store.SessionAlert, child store.AgentSession, recipientID string) int {
	items, err := s.store.SessionInboxItems(ctx, recipientID, time.Now().Add(-7*24*time.Hour), 500)
	if err != nil {
		return 0
	}
	var held []store.SessionInboxItem
	for _, item := range items {
		if item.SenderSessionID == child.ID && item.InputID != alert.ID && item.State == store.InboxHeld &&
			strings.HasPrefix(item.Prompt, sessionalerts.Prefix) && strings.Contains(item.Prompt, "\nCode: "+alert.Code+"\n") {
			held = append(held, item)
		}
	}
	if len(held) == 0 {
		return 0
	}
	merged := 0
	for _, item := range held {
		next := s.sessionService.ChangeInboxItem(ctx, item, store.SessionInboxChange{
			From: []string{store.InboxHeld}, State: store.InboxConsumed, Reason: "merged into alert " + alert.ID,
		})
		if next.State == store.InboxConsumed {
			merged += alertOccurrences(item.Prompt)
		}
	}
	return merged
}

// alertOccurrences is how many occurrences an alert's text (AlertText)
// stands for, merged ones included; at least one.
func alertOccurrences(text string) int {
	const label = "\nOccurrences: "
	at := strings.LastIndex(text, label)
	if at < 0 {
		return 1
	}
	digits := text[at+len(label):]
	if end := strings.IndexFunc(digits, func(r rune) bool { return r < '0' || r > '9' }); end >= 0 {
		digits = digits[:end]
	}
	count, err := strconv.Atoi(digits)
	if err != nil || count < 1 {
		return 1
	}
	return count
}
