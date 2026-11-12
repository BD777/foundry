package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/modelpool"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	sessionRetryPumpInterval = time.Second
	sessionRetryLease        = 2 * time.Minute
	maxSameModelRetries      = 5
)

type sessionRetryService struct {
	server *Server
}

func newSessionRetryService(server *Server) *sessionRetryService {
	return &sessionRetryService{server: server}
}

func (r *sessionRetryService) Failed(ctx context.Context, session store.AgentSession, failure string) (bool, error) {
	if connection := r.server.hub.connectionFor(session.DeviceID); connection == nil ||
		!connection.hasCapability(store.DaemonCapabilityDispatchRetry) {
		_ = r.server.store.UpdateSessionRetry(ctx, session.ID, session.Input.ID,
			store.SessionRetryExhausted, "the device's worker does not support dispatch retries", time.Now().UTC())
		return false, nil
	}
	code := r.server.sessionAlertFailureCode(ctx, session)
	if modelpool.QuotaExhausted(code, failure) {
		// Waiting does not bring an exhausted account's quota back.
		_ = r.server.store.UpdateSessionRetry(ctx, session.ID, session.Input.ID,
			store.SessionRetryExhausted, failure, time.Now().UTC())
		return false, nil
	}
	if !modelpool.RateLimited(code, failure) {
		_ = r.server.store.UpdateSessionRetry(ctx, session.ID, session.Input.ID,
			store.SessionRetryExhausted, failure, time.Now().UTC())
		return false, nil
	}
	current, found, err := r.server.store.GetSessionRetry(ctx, session.ID, session.Input.ID)
	if err != nil {
		return false, err
	}
	attempt := 1
	if found && current.Status != store.SessionRetryResolved && current.Status != store.SessionRetryCanceled {
		attempt = current.Attempt + 1
	}
	if attempt > maxSameModelRetries {
		_ = r.server.store.UpdateSessionRetry(ctx, session.ID, session.Input.ID,
			store.SessionRetryExhausted, failure, time.Now().UTC())
		return false, nil
	}
	delay := modelpool.Backoff(attempt, retryJitter(attempt))
	retry := store.SessionRetry{
		SessionID: session.ID, InputID: session.Input.ID, Attempt: attempt,
		MaxAttempts: maxSameModelRetries, PreviousModel: session.Model, NextModel: session.Model,
		NextAttemptAt: time.Now().UTC().Add(delay), LastError: failure,
	}
	blocked, err := r.server.store.ScheduleAgentSessionRetry(ctx, retry,
		fmt.Sprintf("Model rate limit; automatic retry %d/%d in %s", attempt, maxSameModelRetries, delay.Round(time.Second)))
	if err != nil {
		return false, err
	}
	r.server.hub.sessions.Changed(ctx, sessions.Blocked, blocked)
	event := retryEvent(session, attempt, maxSameModelRetries, session.Model, "Automatic model retry")
	if err := r.server.store.AppendAgentSessionEvent(ctx, event); err != nil {
		return false, err
	}
	r.server.hub.sessions.Recorded(ctx, session.WorkspaceID, event)
	return true, nil
}

func (r *sessionRetryService) Started(ctx context.Context, session store.AgentSession) {
	if err := r.server.store.UpdateSessionRetry(ctx, session.ID, session.Input.ID,
		store.SessionRetryRunning, "", time.Now().UTC()); err != nil {
		log.Printf("session retry: mark %s running: %v", session.ID, err)
	}
}

func (r *sessionRetryService) Completed(ctx context.Context, session store.AgentSession, failed bool) {
	status := store.SessionRetryResolved
	if failed {
		status = store.SessionRetryExhausted
	}
	if err := r.server.store.UpdateSessionRetry(ctx, session.ID, session.Input.ID,
		status, session.Error, time.Now().UTC()); err != nil {
		log.Printf("session retry: resolve %s: %v", session.ID, err)
	}
}

func (r *sessionRetryService) Pending(ctx context.Context, session store.AgentSession, _ string) bool {
	retry, found, err := r.server.store.GetSessionRetry(ctx, session.ID, session.Input.ID)
	if err != nil || !found {
		return false
	}
	switch retry.Status {
	case store.SessionRetryPending, store.SessionRetryDispatching, store.SessionRetryRunning:
		return retry.Attempt <= retry.MaxAttempts
	default:
		return false
	}
}

func (r *sessionRetryService) Pump(ctx context.Context, now time.Time) {
	due, err := r.server.store.DueSessionRetries(ctx, now.UTC(), 100)
	if err != nil {
		log.Printf("session retries: list due: %v", err)
		return
	}
	for _, retry := range due {
		if ctx.Err() != nil {
			return
		}
		session, err := r.server.store.GetAgentSessionRecord(ctx, retry.SessionID)
		if err != nil || session.Input.ID != retry.InputID || !store.IsActiveSessionStatus(session.Status) {
			_ = r.server.store.UpdateSessionRetry(ctx, retry.SessionID, retry.InputID,
				store.SessionRetryCanceled, "session input moved on", now.UTC())
			continue
		}
		claimed, err := r.server.store.ClaimAgentSessionRetry(ctx, retry, now.UTC().Add(sessionRetryLease))
		if errors.Is(err, store.ErrNotFound) {
			continue
		}
		if err != nil {
			log.Printf("session retry: claim %s/%s: %v", retry.SessionID, retry.InputID, err)
			continue
		}
		prompt, err := r.promptForRetry(ctx, claimed)
		if err != nil {
			log.Printf("session retry: inspect progress %s/%s: %v", retry.SessionID, retry.InputID, err)
			continue
		}
		claimed.Input.Prompt = prompt
		event := retryEvent(claimed, retry.Attempt, retry.MaxAttempts,
			claimed.Model, "Automatic model retry started")
		if err := r.server.store.AppendAgentSessionEvent(ctx, event); err == nil {
			r.server.hub.sessions.Recorded(ctx, claimed.WorkspaceID, event)
		}
		if _, err := r.server.sessionService.DispatchOrWait(ctx, claimed); err != nil {
			_ = r.server.store.UpdateSessionRetry(ctx, retry.SessionID, retry.InputID,
				store.SessionRetryExhausted, err.Error(), time.Now().UTC())
			log.Printf("session retry: dispatch %s/%s: %v", retry.SessionID, retry.InputID, err)
		}
	}
}

func (r *sessionRetryService) promptForRetry(ctx context.Context, session store.AgentSession) (string, error) {
	if session.NativeSessionID == "" {
		return session.Input.Prompt, nil
	}
	before := ""
	var events []store.AgentSessionEvent
	foundInput := false
	for range 20 {
		page, older, err := r.server.store.AgentSessionEventWindow(ctx, session.ID, before, 200)
		if err != nil {
			return "", err
		}
		events = append(events, page...)
		if eventWindowContainsInput(page, session.Input.ID) {
			foundInput = true
			break
		}
		if older == "" {
			break
		}
		before = older
	}
	if !foundInput || !modelProgressed(events, session.Input.ID) {
		return session.Input.Prompt, nil
	}
	locale := ""
	if session.CreatedByUserID != "" {
		if user, err := r.server.store.GetUser(ctx, session.CreatedByUserID); err == nil {
			locale = user.Locale
		}
	}
	return retryContinuationPrompt(locale), nil
}

func eventWindowContainsInput(events []store.AgentSessionEvent, inputID string) bool {
	want := store.SessionInputEventID(inputID)
	for _, event := range events {
		if event.ID == want {
			return true
		}
	}
	return false
}

func modelProgressed(events []store.AgentSessionEvent, inputID string) bool {
	want := store.SessionInputEventID(inputID)
	var since time.Time
	for _, event := range events {
		if event.ID == want {
			since, _ = time.Parse(time.RFC3339Nano, event.At)
			break
		}
	}
	if since.IsZero() {
		return false
	}
	for _, event := range events {
		at, _ := time.Parse(time.RFC3339Nano, event.At)
		if event.ID == want || at.Before(since) {
			continue
		}
		if event.Message != nil && event.Message.Kind == "assistant" {
			return true
		}
		if event.Metadata != nil &&
			(event.Metadata.RequestUsage != nil || event.Metadata.TurnUsage != nil ||
				event.Metadata.ContextUsage != nil) {
			return true
		}
		switch event.Label {
		case store.EventLabelResponseStream,
			store.EventLabelClaudeTurnEnd,
			store.EventLabelCodexTurnEnd,
			store.EventLabelProfileCommandTurnEnd,
			store.ProcessLabelThinking,
			store.ProcessLabelThought,
			store.ProcessLabelUsingTool,
			store.ProcessLabelUsedTool,
			store.ProcessLabelToolFailed,
			store.ProcessLabelCommentary,
			store.ProcessLabelSearching,
			store.ProcessLabelSearched,
			store.ProcessLabelRunningCommand,
			store.ProcessLabelRanCommand,
			store.ProcessLabelEditingFile,
			store.ProcessLabelEditedFile,
			store.ProcessLabelUpdatedPlan,
			store.ProcessLabelProcessingStep,
			store.ProcessLabelProcessedStep,
			store.ProcessLabelStartingSubtask,
			store.ProcessLabelSubtaskRunning,
			store.ProcessLabelSubtaskCompleted,
			store.ProcessLabelSubtaskFailed:
			return true
		}
	}
	return false
}

func retryContinuationPrompt(locale string) string {
	if strings.HasPrefix(strings.ToLower(locale), "zh") {
		return "上一次尝试因模型限流中断。请从中断处继续，不要重复已经完成的步骤。"
	}
	return "The previous attempt was interrupted by a model rate limit. Continue from where it stopped and do not repeat steps that already completed."
}

func retryEvent(session store.AgentSession, attempt, maxAttempts int, model, label string) store.AgentSessionEvent {
	if model == "" {
		model = "the same model"
	}
	detail := fmt.Sprintf("Model rate limit. Retrying with %s (attempt %d of %d).", model, attempt, maxAttempts)
	phase := "scheduled"
	if strings.Contains(strings.ToLower(label), "started") {
		phase = "started"
	}
	return store.AgentSessionEvent{
		ID:        fmt.Sprintf("evt_%s_%s_retry_%d_%s", session.ID, session.Input.ID, attempt, phase),
		SessionID: session.ID, At: time.Now().UTC().Format(time.RFC3339Nano),
		Label: label, Detail: detail, Level: "warning",
	}
}

func retryJitter(attempt int) time.Duration {
	limit := modelpool.BaseRetryDelay * time.Duration(1<<max(attempt-1, 0)) / 4
	if limit <= 0 {
		return 0
	}
	return time.Duration(time.Now().UnixNano()%int64(limit)) * time.Nanosecond
}
