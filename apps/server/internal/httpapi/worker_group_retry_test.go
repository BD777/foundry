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

func retryChildWithGroup(t *testing.T, pool bool) (*childReportFixture, store.AgentSession) {
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
		saved, err := f.db.SaveWorkerGroup(ctx, store.StoredWorkerGroup{
			OwnerUserID: "user_lineage", Label: "Equivalent",
			Members: []store.WorkerGroupMember{
				{ProviderKind: "subscription", ProviderID: "profile_lineage", Runtime: "claude", Model: "model-a", TokensPerMinute: 100},
				{ProviderKind: "subscription", ProviderID: "profile_lineage", Runtime: "claude", Model: "model-b", TokensPerMinute: 1_000},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		f.child, err = f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
			WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
			ProfileID: "profile_lineage", Model: "model-a", WorkerGroupID: saved.ID,
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
	f, _ := retryChildWithGroup(t, true)
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
	f, child := retryChildWithGroup(t, false)
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
			f, child := retryChildWithGroup(t, true)
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

func TestPoolSessionRateLimitRetriesTheSameModelAndNeverSwitches(t *testing.T) {
	ctx := context.Background()
	f, child := retryChildWithGroup(t, true)
	originalInput, originalParent := child.Input.ID, child.ParentSessionID

	if !failRetryAttempt(t, f, 1) {
		t.Fatal("first rate limit did not schedule a retry")
	}
	retry, found, err := f.db.GetSessionRetry(ctx, child.ID, originalInput)
	if err != nil || !found || retry.Attempt != 1 || retry.NextModel != "model-a" ||
		retry.PreviousModel != "model-a" || retry.MaxAttempts != maxSameModelRetries {
		t.Fatalf("retry after first failure = %+v, %v, %v", retry, found, err)
	}
	claimed, err := f.db.ClaimAgentSessionRetry(ctx, retry, time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if claimed.Input.ID != originalInput || claimed.ParentSessionID != originalParent ||
		claimed.Model != "model-a" || claimed.Status != "queued" {
		t.Fatalf("claimed retry = %+v", claimed)
	}
	f.child = claimed
	if _, err := f.db.StartAgentSession(ctx, claimed.ID); err != nil {
		t.Fatal(err)
	}
	for attempt := 2; attempt <= maxSameModelRetries; attempt++ {
		if !failRetryAttempt(t, f, attempt) {
			t.Fatalf("rate limit %d was not retried; want %d retries", attempt, maxSameModelRetries)
		}
		retry, found, err = f.db.GetSessionRetry(ctx, child.ID, originalInput)
		if err != nil || !found || retry.Attempt != attempt || retry.NextModel != "model-a" {
			t.Fatalf("retry %d = %+v, %v, %v; want the same model", attempt, retry, found, err)
		}
		claimed, err = f.db.ClaimAgentSessionRetry(ctx, retry, time.Now().Add(time.Minute))
		if err != nil || claimed.Model != "model-a" {
			t.Fatalf("claimed retry %d = %+v, %v", attempt, claimed, err)
		}
		f.child = claimed
		if _, err := f.db.StartAgentSession(ctx, claimed.ID); err != nil {
			t.Fatal(err)
		}
	}
	if failRetryAttempt(t, f, maxSameModelRetries+1) {
		t.Fatal("a session retried past the same-model limit")
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
		t.Fatalf("exhausted alerts = %+v, want one delivered model_rate_limit", alerts)
	}
	events, _, err := f.db.AgentSessionEventWindow(ctx, child.ID, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if strings.Contains(event.Detail, "Switching") {
			t.Fatalf("an automatic retry switched models: %+v", event)
		}
	}
	final, err := f.db.GetAgentSessionRecord(ctx, child.ID)
	if err != nil || final.Model != "model-a" {
		t.Fatalf("session model after retries = %q, %v; want model-a", final.Model, err)
	}
}

func TestWorkerGroupAllocationIsFixedAtCreation(t *testing.T) {
	ctx := context.Background()
	f, child := retryChildWithGroup(t, true)
	if child.Model != "model-a" || child.WorkerGroupID == "" {
		t.Fatalf("group session = model %q pool %q", child.Model, child.WorkerGroupID)
	}
	if _, err := f.db.CompleteAgentSession(ctx, child.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	// A follow-up message that names no model keeps the allocated one.
	sent, err := f.db.SendAgentSessionInput(ctx, child.ID, store.SendAgentSessionInput{Prompt: "continue"})
	if err != nil {
		t.Fatal(err)
	}
	if sent.Model != "model-a" || sent.WorkerGroupID != child.WorkerGroupID {
		t.Fatalf("after send = model %q pool %q, want the allocation kept", sent.Model, sent.WorkerGroupID)
	}
}
