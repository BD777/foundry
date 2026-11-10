package httpapi

import (
	"context"
	"fmt"
	"strings"
	"time"

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
		Initiator:   s.sessionService.TurnInitiator,
		FailureCode: s.sessionAlertFailureCode,
		CanceledBy:  s.sessionAlertCanceledBy,
		DeviceOffline: func(_ context.Context, session store.AgentSession) bool {
			return s.sessionService.WaitsForDevice(session)
		},
		RetryPending: automaticSessionRetryPending,
		Deliver:      s.deliverSessionAlert,
	})
}

// automaticSessionRetryPending reserves the point where a future 429
// backoff/model switch can say that this failure will still be retried.
// Foundry has no automatic session retry yet, so every permanent failure is
// reported now.
func automaticSessionRetryPending(context.Context, store.AgentSession, string) bool {
	return false
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
		return sessionalerts.SafeCode(string(failure.Code))
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
