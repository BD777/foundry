package httpapi

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func enablePendingRetries(f *pendingFixture) {
	connection := newDaemonConnection(f.server.hub, nil)
	connection.registration = store.DaemonRegistration{
		Capabilities: []string{store.DaemonCapabilityDispatchRetry},
	}
	f.server.hub.connections[f.session.DeviceID] = connection
	f.t.Cleanup(func() {
		delete(f.server.hub.connections, f.session.DeviceID)
	})
}

func failPendingTurn(f *pendingFixture, id, text, code string) bool {
	f.t.Helper()
	ctx := context.Background()
	if err := pendingDB(f).AppendAgentSessionEvent(ctx, pendingTurnFailureEvent(f, id, text, code)); err != nil {
		f.t.Fatal(err)
	}
	scheduled, err := f.server.sessionRetries.Failed(ctx, f.session, text)
	if err != nil {
		f.t.Fatal(err)
	}
	return scheduled
}

func pendingTurnFailureEvent(f *pendingFixture, id, text, code string) store.AgentSessionEvent {
	return store.AgentSessionEvent{
		ID: id, SessionID: f.session.ID, Label: store.ProcessLabelSessionFailed,
		Detail: text, Level: "error",
		Metadata: &store.AgentSessionEventMetadata{
			WorkerFailure: &store.WorkerFailure{Version: 1, Code: code, InputID: f.session.Input.ID},
		},
	}
}

func pendingDB(f *pendingFixture) *sqlitestore.Store {
	return f.server.store.(*sqlitestore.Store)
}

func openFailureItems(t *testing.T, f *pendingFixture) []store.PendingItem {
	t.Helper()
	items, err := pendingDB(f).ListPendingItems(context.Background(), f.session.CreatedByUserID,
		[]string{store.PendingOpen}, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	var failures []store.PendingItem
	for _, item := range items {
		if item.Source == store.PendingSourceTurnFailed {
			failures = append(failures, item)
		}
	}
	return failures
}

func TestPendingTurnFailureWaitsForRetryDecision(t *testing.T) {
	f := newPendingFixture(t)
	enablePendingRetries(f)
	const failure = "API Error: 429 rate_limit_error"
	event := pendingTurnFailureEvent(f, "evt_rate_limited", failure, "model_rate_limit")
	pendingReactions{f.server}.SessionEventRecorded(context.Background(), event)
	if items := openFailureItems(t, f); len(items) != 0 {
		t.Fatalf("the Worker's failure event created pending items before the retry decision: %+v", items)
	}
	if !failPendingTurn(f, event.ID, failure, "model_rate_limit") {
		t.Fatal("the first rate limit did not schedule a retry")
	}
	if items := openFailureItems(t, f); len(items) != 0 {
		t.Fatalf("a retryable failure created pending items: %+v", items)
	}
}

func TestTurnFailureClassification(t *testing.T) {
	now := time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name, code, text, want string
	}{
		{"quota", "model_quota_exhausted", "weekly limit reached", store.PendingFailureQuotaExhausted},
		{"rate", "model_rate_limit", "API Error: 429 rate_limit_error", store.PendingFailureRateLimited},
		{"provider down", "", "API Error: 503 no eligible upstream account", store.PendingFailureProviderUnavailable},
		{"provider mismatch", "", "This chat uses gateway, but your current provider is openai.", store.PendingFailureProviderMismatch},
		{"host stopped", "", "The execution host stopped. Retry explicitly.", store.PendingFailureHostStopped},
		{"other", "", "The requested model is unsupported", store.PendingFailureOther},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if got := classifyTurnFailure(test.code, test.text, now).category; got != test.want {
				t.Fatalf("category = %q, want %q", got, test.want)
			}
		})
	}
}

func TestTurnFailureFallbackExpiry(t *testing.T) {
	now := time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name string
		item store.PendingItem
		want string
	}{
		{
			name: "rate one hour",
			item: store.PendingItem{FailureCategory: store.PendingFailureRateLimited,
				UpdatedAt: now.Add(-2 * time.Hour).Format(time.RFC3339Nano)},
			want: "rate_limit_window_elapsed",
		},
		{
			name: "provider six hours",
			item: store.PendingItem{FailureCategory: store.PendingFailureProviderUnavailable,
				UpdatedAt: now.Add(-7 * time.Hour).Format(time.RFC3339Nano)},
			want: "provider_unavailable_window_elapsed",
		},
		{
			name: "reset wins",
			item: store.PendingItem{FailureCategory: store.PendingFailureQuotaExhausted,
				FailureResetAt: now.Add(-time.Minute).Format(time.RFC3339Nano),
				UpdatedAt:      now.Format(time.RFC3339Nano)},
			want: "reset_elapsed",
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if got := failureExpiry(test.item, now); got != test.want {
				t.Fatalf("expiry = %q, want %q", got, test.want)
			}
		})
	}
}

func TestTurnFailureResetParsing(t *testing.T) {
	after := time.Date(2026, 11, 5, 15, 28, 0, 0, time.UTC)
	cases := []struct {
		name, text string
		want       time.Time
	}{
		{
			name: "duration and UTC",
			text: "API Error: 429 upstream account quota; available again at 04:02 UTC (in 12h34m)",
			want: time.Date(2026, 11, 6, 4, 2, 0, 0, time.UTC),
		},
		{
			name: "month and IANA zone",
			text: "You've hit your weekly limit · resets Nov 6, 2pm (America/Toronto)",
			want: time.Date(2026, 11, 6, 19, 0, 0, 0, time.UTC),
		},
		{
			name: "RFC3339",
			text: "quota resets 2026-11-13T00:00:00Z",
			want: time.Date(2026, 11, 13, 0, 0, 0, 0, time.UTC),
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got := parseFailureReset(test.text, after)
			if !got.Equal(test.want) {
				t.Fatalf("reset = %s, want %s", got, test.want)
			}
		})
	}
}

func TestProviderMismatchResolvesAfterProviderChange(t *testing.T) {
	item := store.PendingItem{
		FailureCategory:  store.PendingFailureProviderMismatch,
		FailureProvider:  "codex",
		FailureAccountID: "codex_provider_llm_gateway",
		Excerpt:          "This chat uses foundry_codex_provider_llm_gateway, but your current provider is openai.",
	}
	session := store.AgentSession{
		Provider: "codex", ProfileID: "codex_provider_llm_gateway",
	}
	if !providerMismatchResolved(item, session) {
		t.Fatal("switching back to the provider named by the failed chat did not resolve the mismatch")
	}
}

func TestPendingTurnFailureAppearsAfterRetriesAreExhausted(t *testing.T) {
	f := newPendingFixture(t)
	enablePendingRetries(f)
	ctx := context.Background()
	current := f.session
	for attempt := 1; attempt <= maxSameModelRetries; attempt++ {
		f.session = current
		if !failPendingTurn(f, fmt.Sprintf("evt_exhausted_%d", attempt), "API Error: 429 rate_limit_error", "model_rate_limit") {
			t.Fatalf("attempt %d did not schedule its retry", attempt)
		}
		retry, found, err := pendingDB(f).GetSessionRetry(ctx, current.ID, current.Input.ID)
		if err != nil || !found {
			t.Fatalf("retry %d = %+v, found %v, err %v", attempt, retry, found, err)
		}
		claimed, err := pendingDB(f).ClaimAgentSessionRetry(ctx, retry, time.Now().Add(time.Minute))
		if err != nil {
			t.Fatal(err)
		}
		current, err = pendingDB(f).StartAgentSession(ctx, claimed.ID)
		if err != nil {
			t.Fatal(err)
		}
	}
	f.session = current
	if failPendingTurn(f, "evt_exhausted_last", "API Error: 429 rate_limit_error", "model_rate_limit") {
		t.Fatal("a failure past the retry limit scheduled another retry")
	}
	items := openFailureItems(t, f)
	if len(items) != 1 || items[0].FailureCategory != store.PendingFailureRateLimited ||
		items[0].Occurrences != 1 {
		t.Fatalf("terminal retry item = %+v, want one rate-limit failure", items)
	}
}

func TestPendingTurnFailuresMergeByRootCause(t *testing.T) {
	f := newPendingFixture(t)
	ctx := context.Background()
	second, err := pendingDB(f).CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: f.session.WorkspaceID, AgentID: f.session.AgentID,
		Provider: string(f.session.Provider), ProfileID: f.session.ProfileID,
		Prompt: "another chat", Source: "chat", CreatedByUserID: f.session.CreatedByUserID,
	})
	if err != nil {
		t.Fatal(err)
	}
	failPendingTurn(f, "evt_provider_down_one", "API Error: 503 no eligible upstream account", "provider_unavailable")
	firstID := f.session.ID
	f.session = second
	failPendingTurn(f, "evt_provider_down_two", "API Error: 503 no eligible upstream account", "provider_unavailable")
	items := openFailureItems(t, f)
	if len(items) != 1 || items[0].Occurrences != 2 || len(items[0].FailureSessions) != 2 ||
		items[0].FailureCategory != store.PendingFailureProviderUnavailable ||
		!hasFailureSession(items[0].FailureSessions, firstID) || !hasFailureSession(items[0].FailureSessions, second.ID) {
		t.Fatalf("merged provider failures = %+v", items)
	}
}

func TestPendingTurnFailureClosesAfterSuccessInTheGroup(t *testing.T) {
	f := newPendingFixture(t)
	ctx := context.Background()
	running, err := pendingDB(f).StartAgentSession(ctx, f.session.ID)
	if err != nil {
		t.Fatal(err)
	}
	f.session = running
	failPendingTurn(f, "evt_success_group", "API Error: 503 no eligible upstream account", "provider_unavailable")
	second, err := pendingDB(f).CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: f.session.WorkspaceID, AgentID: f.session.AgentID,
		Provider: string(f.session.Provider), ProfileID: f.session.ProfileID,
		Prompt: "second chat", Source: "chat", CreatedByUserID: f.session.CreatedByUserID,
	})
	if err != nil {
		t.Fatal(err)
	}
	failPendingTurn(f, "evt_success_group_two", "API Error: 503 no eligible upstream account", "provider_unavailable")
	completed, err := pendingDB(f).CompleteAgentSession(ctx, f.session.ID, "recovered", "native-recovered")
	if err != nil {
		t.Fatal(err)
	}
	pendingReactions{f.server}.SessionChanged(ctx, sessions.Completed, sessions.Slim(completed))
	items := openFailureItems(t, f)
	if len(items) != 0 {
		t.Fatalf("success left grouped failures open: %+v", items)
	}
	all, err := pendingDB(f).ListPendingItems(ctx, f.session.CreatedByUserID,
		[]string{store.PendingDone}, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 || all[0].ResolutionReason != store.PendingResolutionAutoResolved ||
		all[0].ResolutionDetail != "turn_succeeded" {
		t.Fatalf("success resolution = %+v", all)
	}
	_ = second
}

func TestPendingTurnFailureClosesWhenResetPassed(t *testing.T) {
	f := newPendingFixture(t)
	text := "API Error: 429 upstream account quota usage limit has been reached; resets 2020-01-01T00:00:00Z"
	failPendingTurn(f, "evt_reset_passed", text, "model_quota_exhausted")
	f.server.maintainPendingTurnFailures(context.Background())
	items := openFailureItems(t, f)
	if len(items) != 0 {
		t.Fatalf("an elapsed reset left failures open: %+v", items)
	}
	done, err := pendingDB(f).ListPendingItems(context.Background(), f.session.CreatedByUserID,
		[]string{store.PendingDone}, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(done) != 1 || done[0].ResolutionReason != store.PendingResolutionAutoResolved ||
		done[0].ResolutionDetail != "reset_elapsed" {
		t.Fatalf("reset resolution = %+v", done)
	}
}

func TestPendingTurnFailuresKeepOtherPerSession(t *testing.T) {
	f := newPendingFixture(t)
	ctx := context.Background()
	first, err := pendingDB(f).StartAgentSession(ctx, f.session.ID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := pendingDB(f).CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: f.session.WorkspaceID, AgentID: f.session.AgentID,
		Provider: string(f.session.Provider), ProfileID: f.session.ProfileID,
		Prompt: "second other", Source: "chat", CreatedByUserID: f.session.CreatedByUserID,
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err = pendingDB(f).StartAgentSession(ctx, second.ID)
	if err != nil {
		t.Fatal(err)
	}
	f.session = first
	failPendingTurn(f, "evt_other_one", "The requested model is unsupported", "other")
	f.session = second
	failPendingTurn(f, "evt_other_two", "The requested model is unsupported", "other")
	items := openFailureItems(t, f)
	if len(items) != 2 {
		t.Fatalf("other failures merged: %+v", items)
	}
	completed, err := pendingDB(f).CompleteAgentSession(ctx, first.ID, "first recovered", "native-first")
	if err != nil {
		t.Fatal(err)
	}
	pendingReactions{f.server}.SessionChanged(ctx, sessions.Completed, sessions.Slim(completed))
	items = openFailureItems(t, f)
	if len(items) != 1 || items[0].SessionID != second.ID {
		t.Fatalf("one other session's success resolved another session's item: %+v", items)
	}
}

func TestPendingTurnFailureMigrationIsIdempotent(t *testing.T) {
	f := newPendingFixture(t)
	ctx := context.Background()
	second, err := pendingDB(f).CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: f.session.WorkspaceID, AgentID: f.session.AgentID,
		Provider: string(f.session.Provider), ProfileID: f.session.ProfileID,
		Prompt: "legacy second", Source: "chat", CreatedByUserID: f.session.CreatedByUserID,
	})
	if err != nil {
		t.Fatal(err)
	}
	for index, session := range []store.AgentSession{f.session, second} {
		item := store.PendingItem{
			UserID: session.CreatedByUserID, WorkspaceID: session.WorkspaceID, SessionID: session.ID,
			EventID: fmt.Sprintf("evt_legacy_failure_%d", index),
			Source:  store.PendingSourceTurnFailed, Key: "failed:" + session.ID,
			Title:   "API Error: Request rejected · upstream account quota usage limit",
			Excerpt: "API Error: Request rejected · upstream account quota usage limit",
		}
		if _, _, err := pendingDB(f).RecordPendingItem(ctx, item); err != nil {
			t.Fatal(err)
		}
	}
	f.server.maintainPendingTurnFailures(ctx)
	items := openFailureItems(t, f)
	if len(items) != 1 || items[0].Occurrences != 2 || len(items[0].FailureSessions) != 2 {
		t.Fatalf("first migration = %+v", items)
	}
	id := items[0].ID
	f.server.maintainPendingTurnFailures(ctx)
	items = openFailureItems(t, f)
	if len(items) != 1 || items[0].ID != id || items[0].Occurrences != 2 {
		t.Fatalf("second migration = %+v", items)
	}
	done, err := pendingDB(f).ListPendingItems(ctx, f.session.CreatedByUserID, []string{store.PendingDone}, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	merged := 0
	for _, item := range done {
		if item.Source == store.PendingSourceTurnFailed && item.ResolutionReason == store.PendingResolutionMerged {
			merged++
		}
	}
	if merged != 2 {
		t.Fatalf("merged legacy items = %d, want 2: %+v", merged, done)
	}
}

func TestPendingTurnFailureMigrationClosesResolvedProviderMismatch(t *testing.T) {
	f := newPendingFixture(t)
	ctx := context.Background()
	session := f.session
	const detail = "This chat uses codex, but your current provider is openai."
	if _, _, err := pendingDB(f).RecordPendingItem(ctx, store.PendingItem{
		UserID: session.CreatedByUserID, WorkspaceID: session.WorkspaceID, SessionID: session.ID,
		EventID: "evt_legacy_mismatch", Source: store.PendingSourceTurnFailed,
		Key: "failed:" + session.ID, Title: detail, Excerpt: detail,
	}); err != nil {
		t.Fatal(err)
	}
	f.server.maintainPendingTurnFailures(ctx)
	done, err := pendingDB(f).ListPendingItems(ctx, f.session.CreatedByUserID,
		[]string{store.PendingDone}, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(done) != 1 || done[0].ResolutionReason != store.PendingResolutionAutoResolved ||
		done[0].ResolutionDetail != "provider_changed" {
		t.Fatalf("provider mismatch migration = %+v", done)
	}
}

func hasFailureSession(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
