package httpapi

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func retryChildWithPool(t *testing.T, pool bool) (*childReportFixture, store.AgentSession) {
	t.Helper()
	ctx := context.Background()
	f := newChildReportFixture(t)
	connection := newDaemonConnection(f.server.hub, nil)
	connection.registration = store.DaemonRegistration{
		Capabilities: []string{store.DaemonCapabilityDispatchRetry},
	}
	f.server.hub.connections["dev_lineage"] = connection
	t.Cleanup(func() {
		delete(f.server.hub.connections, "dev_lineage")
	})
	if pool {
		saved, err := f.db.SaveModelPool(ctx, store.StoredModelPool{
			OwnerUserID: "user_lineage", ProviderKind: "subscription",
			ProviderID: "profile_lineage", Runtime: "claude", Label: "Equivalent",
			Members: []store.EquivalentModelMember{
				{Model: "model-a", TokensPerMinute: 100},
				{Model: "model-b", TokensPerMinute: 1_000},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		f.child, err = f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
			WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
			ProfileID: "profile_lineage", Model: "model-a", ModelPoolID: saved.ID,
			Prompt: "retry this input once", Source: "agent", ParentSessionID: f.parent.ID,
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.db.StartAgentSession(ctx, f.child.ID); err != nil {
		t.Fatal(err)
	}
	return f, f.child
}

func TestAutomaticRetryRequiresDispatchRetryCapability(t *testing.T) {
	f, _ := retryChildWithPool(t, true)
	connection := f.server.hub.connectionFor("dev_lineage")
	if connection == nil {
		t.Fatal("retry fixture has no connected worker")
	}
	connection.registration = store.DaemonRegistration{}
	if failRetryAttempt(t, f, 1) {
		t.Fatal("a worker without dispatch_retry scheduled an automatic retry")
	}
	if _, found, err := f.db.GetSessionRetry(context.Background(), f.child.ID, f.child.Input.ID); err != nil || found {
		t.Fatalf("retry state without capability = found %v, err %v", found, err)
	}
	failed, err := f.db.FailAgentSession(context.Background(), f.child.ID, "API Error: 429 rate_limit_error")
	if err != nil {
		t.Fatal(err)
	}
	sessionAlertReactions{f.server}.SessionChanged(context.Background(), sessions.Completed, sessions.Slim(failed))
	alerts := childAlerts(t, f)
	if len(alerts) != 1 || alerts[0].Code != "model_rate_limit" || alerts[0].NotifiedAt == nil {
		t.Fatalf("alerts without dispatch_retry = %+v, want one immediate alert", alerts)
	}
}

func TestRetryPromptReusesTheInputOnlyBeforeModelProgress(t *testing.T) {
	ctx := context.Background()
	f, child := retryChildWithPool(t, false)
	current, err := f.db.GetAgentSessionRecord(ctx, child.ID)
	if err != nil {
		t.Fatal(err)
	}
	prompt, err := f.server.sessionRetries.promptForRetry(ctx, current)
	if err != nil || prompt != current.Input.Prompt {
		t.Fatalf("prompt before native progress = %q, %v; want original", prompt, err)
	}
	current, err = f.db.SetAgentSessionNativeSessionID(ctx, child.ID, "native_retry")
	if err != nil {
		t.Fatal(err)
	}
	if current.NativeSessionID != "native_retry" {
		t.Fatalf("native session = %q, want native_retry", current.NativeSessionID)
	}
	prompt, err = f.server.sessionRetries.promptForRetry(ctx, current)
	if err != nil || prompt != current.Input.Prompt {
		t.Fatalf("prompt with a native session but no model answer = %q, %v; want original", prompt, err)
	}
	if err := f.db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{
		ID: "evt_retry_progress", SessionID: child.ID, Label: store.EventLabelResponseStream,
		Detail: "I started the task.", Level: "info",
	}); err != nil {
		t.Fatal(err)
	}
	events, _, err := f.db.AgentSessionEventWindow(ctx, child.ID, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	if !modelProgressed(events, current.Input.ID) {
		t.Fatalf("recorded response was not seen as model progress: %+v", events)
	}
	current, err = f.db.GetAgentSessionRecord(ctx, child.ID)
	if err != nil {
		t.Fatal(err)
	}
	prompt, err = f.server.sessionRetries.promptForRetry(ctx, current)
	if err != nil || !strings.Contains(prompt, "Continue from where it stopped") {
		t.Fatalf("prompt after model progress = %q, %v", prompt, err)
	}
	if !strings.Contains(retryContinuationPrompt("zh-CN"), "不要重复") ||
		!strings.Contains(retryContinuationPrompt("en"), "do not repeat") {
		t.Fatal("retry continuation prompt is not localized")
	}
}

func failRetryAttempt(t *testing.T, f *childReportFixture, attempt int) bool {
	t.Helper()
	return failRetryAttemptAs(
		t,
		f,
		attempt,
		"API Error: 429 rate_limit_error",
		"model_rate_limit",
	)
}

func failRetryAttemptAs(t *testing.T, f *childReportFixture, attempt int, text, code string) bool {
	t.Helper()
	ctx := context.Background()
	if err := f.db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{
		ID: fmt.Sprintf("evt_retry_failure_%d", attempt), SessionID: f.child.ID,
		Label: store.ProcessLabelSessionFailed, Detail: text, Level: "error",
		Metadata: &store.AgentSessionEventMetadata{
			WorkerFailure: &store.WorkerFailure{Version: 1, Code: code, InputID: f.child.Input.ID},
		},
	}); err != nil {
		t.Fatal(err)
	}
	scheduled, err := f.server.sessionRetries.Failed(ctx, f.child, text)
	if err != nil {
		t.Fatal(err)
	}
	return scheduled
}

func TestQuotaExhaustionDoesNotRetryAndAlertsOnce(t *testing.T) {
	ctx := context.Background()
	const quotaError = "API Error: Request rejected (429) · upstream account quota usage limit has been reached; an account becomes available again at 07:42 UTC"
	for _, test := range []struct {
		name string
		code string
	}{
		{name: "new quota code", code: "model_quota_exhausted"},
		{name: "older rate-limit code with quota text", code: "model_rate_limit"},
	} {
		t.Run(test.name, func(t *testing.T) {
			f, child := retryChildWithPool(t, true)
			if failRetryAttemptAs(t, f, 1, quotaError, test.code) {
				t.Fatal("quota exhaustion scheduled an automatic retry")
			}
			retry, found, err := f.db.GetSessionRetry(ctx, child.ID, child.Input.ID)
			if err != nil || (found && retry.Status != store.SessionRetryExhausted) {
				t.Fatalf("quota retry state = %+v, found %v, err %v", retry, found, err)
			}
			due, err := f.db.DueSessionRetries(ctx, time.Now().Add(time.Hour), 10)
			if err != nil || len(due) != 0 {
				t.Fatalf("quota retries due = %+v, err %v; want none", due, err)
			}
			failed, err := f.db.FailAgentSession(ctx, child.ID, quotaError)
			if err != nil {
				t.Fatal(err)
			}
			reaction := sessionAlertReactions{f.server}
			reaction.SessionChanged(ctx, sessions.Completed, sessions.Slim(failed))
			reaction.SessionChanged(ctx, sessions.Completed, sessions.Slim(failed))
			alerts := childAlerts(t, f)
			if len(alerts) != 1 || alerts[0].Code != "model_quota_exhausted" ||
				alerts[0].NotifiedAt == nil {
				t.Fatalf("quota alerts = %+v, want one delivered quota alert", alerts)
			}
			items := parentAlertItems(t, f)
			if len(items) != 1 ||
				!strings.Contains(items[0].Prompt, "Code: model_quota_exhausted") ||
				!strings.Contains(items[0].Prompt, "Automatic retry: no; the provider's account quota") {
				t.Fatalf("quota alert text = %+v", items)
			}
		})
	}
}

func TestPoolRateLimitRetryKeepsInputAndOwnershipThenSwitchesModels(t *testing.T) {
	ctx := context.Background()
	f, child := retryChildWithPool(t, true)
	originalInput, originalParent := child.Input.ID, child.ParentSessionID

	if !failRetryAttempt(t, f, 1) {
		t.Fatal("first rate limit did not schedule a retry")
	}
	retry, found, err := f.db.GetSessionRetry(ctx, child.ID, originalInput)
	if err != nil || !found || retry.Attempt != 1 || retry.NextModel != "model-b" {
		t.Fatalf("retry after first failure = %+v, %v, %v", retry, found, err)
	}
	claimed, err := f.db.ClaimAgentSessionRetry(ctx, retry, time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if claimed.Input.ID != originalInput || claimed.ParentSessionID != originalParent ||
		claimed.Model != "model-b" || claimed.Status != "queued" {
		t.Fatalf("claimed retry = %+v", claimed)
	}
	f.child = claimed
	if _, err := f.db.StartAgentSession(ctx, claimed.ID); err != nil {
		t.Fatal(err)
	}
	if !failRetryAttempt(t, f, 2) {
		t.Fatal("second rate limit did not schedule a retry")
	}
	retry, found, err = f.db.GetSessionRetry(ctx, child.ID, originalInput)
	if err != nil || !found || retry.Attempt != 2 || retry.NextModel != "model-a" {
		t.Fatalf("retry after second failure = %+v, %v, %v", retry, found, err)
	}
}

func TestRetryExhaustionAlertsOnceAndNonPoolRetriesSameModelOnce(t *testing.T) {
	ctx := context.Background()
	f, child := retryChildWithPool(t, true)
	if !failRetryAttempt(t, f, 1) {
		t.Fatal("first pool retry missing")
	}
	retry, _, err := f.db.GetSessionRetry(ctx, child.ID, child.Input.ID)
	if err != nil {
		t.Fatal(err)
	}
	for attempt := 2; attempt <= maxPoolModelRetries; attempt++ {
		claimed, err := f.db.ClaimAgentSessionRetry(ctx, retry, time.Now().Add(time.Minute))
		if err != nil {
			t.Fatal(err)
		}
		f.child = claimed
		if _, err := f.db.StartAgentSession(ctx, claimed.ID); err != nil {
			t.Fatal(err)
		}
		if !failRetryAttempt(t, f, attempt) {
			t.Fatalf("retry %d exhausted too early", attempt)
		}
		retry, _, err = f.db.GetSessionRetry(ctx, child.ID, child.Input.ID)
		if err != nil {
			t.Fatal(err)
		}
	}
	claimed, err := f.db.ClaimAgentSessionRetry(ctx, retry, time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	f.child = claimed
	if _, err := f.db.StartAgentSession(ctx, claimed.ID); err != nil {
		t.Fatal(err)
	}
	if failRetryAttempt(t, f, maxPoolModelRetries+1) {
		t.Fatal("retry scheduled past the pool limit")
	}
	failed, err := f.db.FailAgentSession(ctx, child.ID, "API Error: 429 rate_limit_error")
	if err != nil {
		t.Fatal(err)
	}
	sessionAlertReactions{f.server}.SessionChanged(ctx, sessions.Completed, sessions.Slim(failed))
	alerts := childAlerts(t, f)
	modelRateLimits := 0
	for _, alert := range alerts {
		if alert.Code == "model_rate_limit" && alert.NotifiedAt != nil {
			modelRateLimits++
		}
		if alert.Code == "blocked" && alert.NotifiedAt != nil {
			t.Fatalf("a retry-in-progress alert was delivered: %+v", alert)
		}
	}
	if modelRateLimits != 1 || len(parentAlertItems(t, f)) != 1 {
		t.Fatalf("exhausted pool alerts = %+v, want one delivered model_rate_limit", alerts)
	}

	t.Run("non-pool same model once", func(t *testing.T) {
		f, child := retryChildWithPool(t, false)
		if !failRetryAttempt(t, f, 1) {
			t.Fatal("same-id retry missing")
		}
		retry, _, err := f.db.GetSessionRetry(ctx, child.ID, child.Input.ID)
		if err != nil || retry.NextModel != child.Model || retry.MaxAttempts != 1 {
			t.Fatalf("same-id retry = %+v, %v", retry, err)
		}
		claimed, err := f.db.ClaimAgentSessionRetry(ctx, retry, time.Now().Add(time.Minute))
		if err != nil {
			t.Fatal(err)
		}
		f.child = claimed
		if claimed.Input.ID != child.Input.ID || claimed.Model != child.Model {
			t.Fatalf("same-id claim = %+v", claimed)
		}
		if _, err := f.db.StartAgentSession(ctx, claimed.ID); err != nil {
			t.Fatal(err)
		}
		if failRetryAttempt(t, f, 2) {
			t.Fatal("same-id session retried more than once")
		}
	})

	events, _, err := f.db.AgentSessionEventWindow(ctx, child.ID, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	switches := 0
	for _, event := range events {
		if event.Label == "Automatic model retry" &&
			strings.Contains(event.Detail, "Switching") {
			switches++
		}
	}
	if switches != maxPoolModelRetries {
		t.Fatalf("automatic switch events = %d, want %d", switches, maxPoolModelRetries)
	}
}
