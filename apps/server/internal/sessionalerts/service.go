// Package sessionalerts turns system incidents of sessions started by
// another session into small, deduplicated alerts for that turn's initiator.
// Turn-end results remain the child-report path; an alert is never
// superseded by a later message.
package sessionalerts

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"
	"unicode"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

const (
	// Prefix opens every alert delivered to a session.
	Prefix = sessions.SessionAlertPrefix

	CodeCanceled      = "canceled"
	CodeBlocked       = "blocked"
	CodeWaitingSlot   = "waiting_for_slot"
	CodeDeviceOffline = "device_offline"
	// CodeModelQuotaExhausted is terminal: no retry can restore an exhausted
	// upstream account, so the initiator is told to replenish or switch it.
	CodeModelQuotaExhausted = "model_quota_exhausted"
)

// WaitAlertAfter keeps ordinary waits quiet for long enough that a normal
// queue or retry does not wake the initiator.
var WaitAlertAfter = 10 * time.Minute

// ErrDeliveryDropped says the alert's recipient cannot take it now and its
// incident should be closed instead of retried forever.
var ErrDeliveryDropped = errors.New("session alert delivery dropped")

// Options are the session-domain facts the alert module reads and the one
// delivery operation it performs. RetryPending is the integration point for
// a future automatic retry policy: a failed observation it holds back is
// reported only after retries are exhausted.
type Options struct {
	Alerts        store.SessionAlertStore
	LoadSession   func(context.Context, string) (store.AgentSession, error)
	Initiator     func(context.Context, store.AgentSession) (string, error)
	FailureCode   func(context.Context, store.AgentSession) string
	CanceledBy    func(context.Context, store.AgentSession) (string, bool)
	DeviceOffline func(context.Context, store.AgentSession) bool
	RetryPending  func(context.Context, store.AgentSession, string) bool
	Deliver       func(context.Context, store.SessionAlert, store.AgentSession, store.AgentSession, string) error
	Now           func() time.Time
}

// Service observes sessions and delivers due incidents.
type Service struct {
	options Options
}

// New builds the alert service.
func New(options Options) *Service {
	if options.Now == nil {
		options.Now = time.Now
	}
	return &Service{options: options}
}

// SessionChanged observes terminal failures/cancellations and clears an
// incident when the session starts or completes successfully again.
func (s *Service) SessionChanged(ctx context.Context, change sessions.Change, session store.AgentSession) {
	now := s.options.Now().UTC()
	switch change {
	case sessions.Started, sessions.Resumed:
		s.resolve(ctx, session.ID, "", now)
	case sessions.Blocked:
		s.observeWait(ctx, session, CodeBlocked, session.BlockedReason, now, true)
	case sessions.Completed:
		switch session.Status {
		case "completed":
			s.resolve(ctx, session.ID, "", now)
		case "failed":
			s.resolve(ctx, session.ID, CodeBlocked, now)
			s.resolve(ctx, session.ID, CodeWaitingSlot, now)
			s.resolve(ctx, session.ID, CodeDeviceOffline, now)
			s.failed(ctx, session, now)
		case "canceled":
			s.resolve(ctx, session.ID, CodeBlocked, now)
			s.resolve(ctx, session.ID, CodeWaitingSlot, now)
			s.resolve(ctx, session.ID, CodeDeviceOffline, now)
			s.canceled(ctx, session, now)
		}
	}
}

// SessionEventRecorded observes the waits an event stream reports before
// any terminal state. Slot and offline waits become due after WaitAlertAfter;
// a completed wait clears its incident.
func (s *Service) SessionEventRecorded(ctx context.Context, event store.AgentSessionEvent) {
	switch event.Label {
	case store.ProcessLabelWaitingForSlot:
		s.waitFromEvent(ctx, event, CodeWaitingSlot, true)
	case store.ProcessLabelWaitedForSlot:
		s.resolve(ctx, event.SessionID, CodeWaitingSlot, s.options.Now().UTC())
	case store.EventLabelDeviceWait:
		child, err := s.options.LoadSession(ctx, event.SessionID)
		if err != nil {
			return
		}
		offline := strings.Contains(strings.ToLower(event.Detail), "offline")
		if s.options.DeviceOffline != nil {
			offline = s.options.DeviceOffline(ctx, child)
		}
		if offline {
			s.observeWait(ctx, child, CodeDeviceOffline, event.Detail, s.options.Now().UTC(), true)
		}
	}
}

// Pump delivers every alert whose quiet period has passed.
func (s *Service) Pump(ctx context.Context, now time.Time) {
	alerts, err := s.options.Alerts.DueSessionAlerts(ctx, now.UTC(), 100)
	if err != nil {
		log.Printf("session alerts: list due alerts: %v", err)
		return
	}
	for _, alert := range alerts {
		if ctx.Err() != nil {
			return
		}
		s.deliver(ctx, alert)
	}
}

func (s *Service) waitFromEvent(ctx context.Context, event store.AgentSessionEvent, code string, willRetry bool) {
	child, err := s.options.LoadSession(ctx, event.SessionID)
	if err != nil {
		return
	}
	s.observeWait(ctx, child, code, event.Detail, s.options.Now().UTC(), willRetry)
}

func (s *Service) observeWait(ctx context.Context, child store.AgentSession, code, detail string, now time.Time, willRetry bool) {
	recipient, ok := s.initiator(ctx, child)
	if !ok {
		return
	}
	s.record(ctx, store.SessionAlertInput{
		RecipientSessionID: recipient, ChildSessionID: child.ID, SourceInputID: child.Input.ID,
		Code: code, DedupeKey: code, Detail: detail, WillRetry: willRetry,
		ObservedAt: now, NotifyAfter: now.Add(WaitAlertAfter),
	})
}

func (s *Service) failed(ctx context.Context, child store.AgentSession, now time.Time) {
	recipient, ok := s.initiator(ctx, child)
	if !ok {
		return
	}
	code := ""
	if s.options.FailureCode != nil {
		code = strings.TrimSpace(s.options.FailureCode(ctx, child))
	}
	if code == "" || strings.EqualFold(code, "unknown") {
		code = classifyFailure(child.Error)
	}
	if s.options.RetryPending != nil && s.options.RetryPending(ctx, child, code) {
		return
	}
	alert, created, err := s.options.Alerts.RecordSessionAlert(ctx, store.SessionAlertInput{
		RecipientSessionID: recipient, ChildSessionID: child.ID, SourceInputID: child.Input.ID,
		Code: code, DedupeKey: code, Detail: child.Error, ObservedAt: now, NotifyAfter: now,
	})
	if err != nil {
		log.Printf("session alert: record failed session %s: %v", child.ID, err)
		return
	}
	if !created && alert.NotifiedAt != nil {
		return
	}
	s.deliver(ctx, alert)
}

func (s *Service) canceled(ctx context.Context, child store.AgentSession, now time.Time) {
	recipient, ok := s.initiator(ctx, child)
	if !ok {
		return
	}
	if s.options.CanceledBy != nil {
		if canceler, known := s.options.CanceledBy(ctx, child); known && canceler == recipient {
			return
		}
	}
	alert, created, err := s.options.Alerts.RecordSessionAlert(ctx, store.SessionAlertInput{
		RecipientSessionID: recipient, ChildSessionID: child.ID, SourceInputID: child.Input.ID,
		Code: CodeCanceled, DedupeKey: CodeCanceled, Detail: child.Error, ObservedAt: now, NotifyAfter: now,
	})
	if err != nil {
		log.Printf("session alert: record canceled session %s: %v", child.ID, err)
		return
	}
	if !created && alert.NotifiedAt != nil {
		return
	}
	s.deliver(ctx, alert)
}

func (s *Service) record(ctx context.Context, input store.SessionAlertInput) {
	if _, _, err := s.options.Alerts.RecordSessionAlert(ctx, input); err != nil {
		log.Printf("session alert: record %s for session %s: %v", input.Code, input.ChildSessionID, err)
	}
}

func (s *Service) initiator(ctx context.Context, child store.AgentSession) (string, bool) {
	recipient, err := s.options.Initiator(ctx, child)
	if err != nil {
		log.Printf("session alert: resolve initiator of %s: %v", child.ID, err)
		return "", false
	}
	recipient = strings.TrimSpace(recipient)
	return recipient, recipient != "" && recipient != child.ID
}

func (s *Service) resolve(ctx context.Context, childID, code string, now time.Time) {
	if _, err := s.options.Alerts.ResolveSessionAlerts(ctx, childID, code, now); err != nil {
		log.Printf("session alert: resolve %s for %s: %v", codeOrAll(code), childID, err)
	}
}

func codeOrAll(code string) string {
	if code == "" {
		return "all alerts"
	}
	return code
}

func (s *Service) deliver(ctx context.Context, alert store.SessionAlert) {
	child, err := s.options.LoadSession(ctx, alert.ChildSessionID)
	if err != nil {
		s.resolve(ctx, alert.ChildSessionID, alert.Code, s.options.Now().UTC())
		return
	}
	if !stillCurrent(alert.Code, child.Status) {
		s.resolve(ctx, alert.ChildSessionID, alert.Code, s.options.Now().UTC())
		return
	}
	recipient, err := s.options.LoadSession(ctx, alert.RecipientSessionID)
	if err != nil || recipient.ID == "" || recipient.ID == child.ID || recipient.ArchivedAt != "" ||
		recipient.Status == "canceled" || recipient.Role != "" {
		s.resolve(ctx, alert.ChildSessionID, alert.Code, s.options.Now().UTC())
		return
	}
	delivery := store.DeliveryTurnEnd
	if store.IsActiveSessionStatus(recipient.Status) {
		delivery = store.DeliveryBoundary
	}
	if err := s.options.Deliver(ctx, alert, child, recipient, delivery); err != nil {
		if errors.Is(err, ErrDeliveryDropped) {
			s.resolve(ctx, alert.ChildSessionID, alert.Code, s.options.Now().UTC())
			return
		}
		log.Printf("session alert: deliver %s for %s: %v", alert.Code, child.ID, err)
		return
	}
	if _, err := s.options.Alerts.MarkSessionAlertNotified(ctx, alert.ID, alert.ID, s.options.Now().UTC()); err != nil {
		log.Printf("session alert: mark %s notified: %v", alert.ID, err)
	}
}

func stillCurrent(code, status string) bool {
	switch code {
	case CodeCanceled:
		return status == "canceled"
	case CodeBlocked:
		return status == "blocked"
	case CodeWaitingSlot:
		return status == "queued" || status == "blocked"
	case CodeDeviceOffline:
		return status == "queued"
	}
	return status == "failed"
}

// AlertText is the complete message the initiator receives. It stays small:
// the detail is one line of at most 160 characters.
func AlertText(alert store.SessionAlert, child store.AgentSession) string {
	status := alertState(alert.Code, child.Status)
	detail := textcut.Excerpt(oneLine(alert.Detail), 160)
	if detail == "" {
		detail = "No error text was reported."
	}
	return fmt.Sprintf("%s session %s (%q) %s.\nCode: %s\nDetail: %s\nAutomatic retry: %s\nNext: %s\nOccurrences: %d",
		Prefix, child.ID, child.Title, status, alert.Code, detail,
		retryText(alert.Code, alert.WillRetry), actionText(alert.Code), alert.Occurrences)
}

func alertState(code, status string) string {
	switch code {
	case CodeCanceled:
		return "was canceled"
	case CodeBlocked:
		return "is blocked"
	case CodeWaitingSlot:
		return "is still waiting for a slot"
	case CodeDeviceOffline:
		return "is waiting for its device"
	}
	switch status {
	case "failed":
		return "failed"
	case "canceled":
		return "was canceled"
	case "completed":
		return "completed"
	}
	return "is " + status
}

func retryText(code string, willRetry bool) string {
	switch code {
	case CodeCanceled:
		return "no"
	case CodeModelQuotaExhausted:
		return "no; the provider's account quota or billing limit is exhausted"
	case CodeWaitingSlot:
		return "yes, when an execution slot frees"
	case CodeDeviceOffline:
		return "yes, when the device reconnects"
	case CodeBlocked:
		return "yes, if the blocking condition clears"
	}
	if willRetry {
		return "yes"
	}
	return "no"
}

func actionText(code string) string {
	switch code {
	case CodeCanceled:
		return "do not resend automatically; inspect the canceller, then send_message only if the work should continue."
	case CodeModelQuotaExhausted:
		return "restore the provider account's quota or credit, or switch to another account; do not resend automatically."
	case CodeBlocked:
		return "let any retry finish; inspect or cancel it if it stays blocked."
	case CodeWaitingSlot:
		return "let it continue; send_message only if it stays stuck or the work is no longer needed."
	case CodeDeviceOffline:
		return "wait for the device to reconnect or redirect the work; do not resend it."
	}
	return "send_message to retry; if it fails again, try another model or account."
}

func oneLine(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

func classifyFailure(text string) string {
	lower := strings.ToLower(text)
	switch {
	case strings.Contains(lower, "cannot read codex's bundled model definitions"),
		strings.Contains(lower, "failed to start"),
		strings.Contains(lower, "startup timeout"),
		strings.Contains(lower, "spawn"):
		return "startup"
	case strings.Contains(lower, "upstream account quota"),
		strings.Contains(lower, "usage limit"),
		strings.Contains(lower, "insufficient_quota"),
		strings.Contains(lower, "quota exhausted"),
		strings.Contains(lower, "quota exceeded"),
		strings.Contains(lower, "billing"),
		strings.Contains(lower, "credit balance"):
		return CodeModelQuotaExhausted
	case strings.Contains(lower, "unexpected status 405"),
		strings.Contains(lower, "wss://"),
		strings.Contains(lower, "api error"),
		strings.Contains(lower, "responses"),
		strings.Contains(lower, "model api"),
		strings.Contains(lower, "model service"),
		strings.Contains(lower, "unauthorized"),
		strings.Contains(lower, "rate limit"):
		return "model_service"
	case strings.Contains(lower, "daemon stopped"),
		strings.Contains(lower, "not connected"),
		strings.Contains(lower, "offline"),
		strings.Contains(lower, "connection closed"):
		return "device_disconnected"
	}
	return "session_failure"
}

// SafeCode makes a machine code safe to put in a one-line alert.
func SafeCode(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var builder strings.Builder
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			builder.WriteRune(r)
		} else if unicode.IsSpace(r) {
			builder.WriteByte('_')
		}
	}
	if builder.Len() == 0 {
		return "session_failure"
	}
	return textcut.Prefix(builder.String(), 80)
}
