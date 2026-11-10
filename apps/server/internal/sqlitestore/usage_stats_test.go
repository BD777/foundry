package sqlitestore

import (
	"context"
	"sort"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/usagestats"
)

func TestUsageRecordIsIdempotentAndRollsUpDaily(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	first := usageTurnForTest("sess_usage", "input_1", "2026-11-10T01:00:00Z")
	first.InputTokens, first.CacheReadTokens, first.OutputTokens = 100, 50, 20
	first.ModelRequests = 2
	first.CostUSD, first.CostSource = 0.25, store.UsageCostReported
	second := usageTurnForTest("sess_usage", "input_2", "2026-11-10T02:00:00Z")
	second.InputTokens, second.CacheReadTokens, second.OutputTokens = 200, 75, 40
	second.ModelRequests = 3

	firstRecord := store.UsageRecord{
		Turn: &first,
		Requests: []store.UsageRequest{{
			RequestID:       "request_1",
			SessionID:       first.SessionID,
			InputID:         first.InputID,
			UserID:          first.UserID,
			WorkspaceID:     first.WorkspaceID,
			DeviceID:        first.DeviceID,
			Entry:           first.Entry,
			At:              first.EndedAt,
			Runtime:         first.Runtime,
			ProfileID:       first.ProfileID,
			ProviderLabel:   first.ProviderLabel,
			RequestedModel:  first.RequestedModel,
			Model:           first.Model,
			InputTokens:     10,
			OutputTokens:    3,
			FirstTokenMs:    100,
			GenerationMs:    400,
			RequestMs:       500,
			TimingEstimated: true,
		}},
	}
	if err := db.RecordUsage(ctx, firstRecord); err != nil {
		t.Fatal(err)
	}
	if err := db.RecordUsage(ctx, firstRecord); err != nil {
		t.Fatal(err)
	}
	if err := db.RecordUsage(ctx, store.UsageRecord{Turn: &second}); err != nil {
		t.Fatal(err)
	}

	if got := usageRowCount(t, db, "usage_turns"); got != 2 {
		t.Fatalf("usage_turns = %d, want 2", got)
	}
	if got := usageRowCount(t, db, "usage_requests"); got != 1 {
		t.Fatalf("usage_requests = %d, want 1", got)
	}
	var requestTimingEstimated bool
	if err := db.db.QueryRowContext(ctx, `SELECT timing_estimated FROM usage_requests WHERE request_id = 'request_1'`).
		Scan(&requestTimingEstimated); err != nil {
		t.Fatal(err)
	}
	if !requestTimingEstimated {
		t.Fatal("request timing estimate was not retained")
	}
	var (
		turns, completed, duration, input, cacheRead, output, requests int64
	)
	if err := db.db.QueryRowContext(ctx, `SELECT turn_count, completed_count, duration_ms,
		input_tokens, cache_read_tokens, output_tokens, model_requests
		FROM usage_daily WHERE day = '2026-11-10' AND user_id = 'user_usage'`).
		Scan(&turns, &completed, &duration, &input, &cacheRead, &output, &requests); err != nil {
		t.Fatal(err)
	}
	if turns != 2 || completed != 2 || duration != 2_000 || input != 300 ||
		cacheRead != 125 || output != 60 || requests != 5 {
		t.Fatalf("daily = turns %d completed %d duration %d input %d cache %d output %d requests %d",
			turns, completed, duration, input, cacheRead, output, requests)
	}
}

func TestUsageTerminalUpdatePreservesReportedUsage(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	turn := usageTurnForTest("sess_failed", "input_failed", "2026-11-11T01:00:00Z")
	turn.InputTokens, turn.OutputTokens = 120, 30
	if err := db.RecordUsage(ctx, store.UsageRecord{Turn: &turn}); err != nil {
		t.Fatal(err)
	}
	terminal := store.UsageTurn{
		SessionID:  turn.SessionID,
		InputID:    turn.InputID,
		EndedAt:    "2026-11-11T01:00:04Z",
		DurationMs: 4_000,
		Outcome:    store.UsageOutcomeFailed,
		ErrorClass: "timeout",
	}
	if err := db.RecordUsage(ctx, store.UsageRecord{Turn: &terminal}); err != nil {
		t.Fatal(err)
	}

	stored, found, err := db.readUsageTurn(ctx, turn.SessionID, turn.InputID)
	if err != nil || !found {
		t.Fatalf("read terminal turn: %+v %v", stored, err)
	}
	if stored.InputTokens != 120 || stored.OutputTokens != 30 || stored.Outcome != store.UsageOutcomeFailed ||
		stored.ErrorClass != "timeout" || stored.DurationMs != 4_000 {
		t.Fatalf("terminal turn = %+v", stored)
	}
	var completed, failed int64
	if err := db.db.QueryRowContext(ctx, `SELECT completed_count, failed_count FROM usage_daily
		WHERE day = '2026-11-11' AND user_id = ?`, turn.UserID).Scan(&completed, &failed); err != nil {
		t.Fatal(err)
	}
	if completed != 0 || failed != 1 {
		t.Fatalf("daily outcomes = completed %d failed %d", completed, failed)
	}
}

func TestUsageRetentionDeletesOnlyOldRequests(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	oldAt := formatTime(now.Add(-100 * 24 * time.Hour))
	newAt := formatTime(now.Add(-10 * 24 * time.Hour))
	turn := usageTurnForTest("sess_retention", "input_retention", oldAt)
	if err := db.RecordUsage(ctx, store.UsageRecord{
		Turn: &turn,
		Requests: []store.UsageRequest{
			{RequestID: "request_old", SessionID: turn.SessionID, InputID: turn.InputID, Entry: store.UsageEntryChat, At: oldAt},
			{RequestID: "request_new", SessionID: turn.SessionID, InputID: turn.InputID, Entry: store.UsageEntryChat, At: newAt},
		},
	}); err != nil {
		t.Fatal(err)
	}
	deleted, err := db.DeleteUsageRequestsBefore(ctx, now.Add(-90*24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if deleted != 1 {
		t.Fatalf("deleted = %d, want 1", deleted)
	}
	if got := usageRowCount(t, db, "usage_requests"); got != 1 {
		t.Fatalf("usage_requests = %d, want 1", got)
	}
	if got := usageRowCount(t, db, "usage_turns"); got != 1 {
		t.Fatalf("usage_turns = %d, want 1", got)
	}
}

func TestUsageBackfillResumesAndCoexistsWithRealtime(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerAgentSessionTestDaemon(t, db, "ws_backfill", "agent_backfill")
	now := time.Now().UTC()
	first, firstEvents := createBackfillSession(t, db, ctx, now.Add(-2*time.Hour), "first")
	second, _ := createBackfillSession(t, db, ctx, now.Add(-time.Hour), "second")
	recorder := usagestats.New(db, nil)
	for _, event := range firstEvents {
		if event.Metadata != nil && event.Metadata.RequestUsage != nil {
			at, err := time.Parse(time.RFC3339Nano, event.At)
			if err != nil {
				t.Fatal(err)
			}
			if at.Before(now.Add(-usagestats.RequestRetention)) {
				continue
			}
		}
		if event.Metadata != nil && (event.Metadata.TurnUsage != nil || event.Metadata.RequestUsage != nil) {
			if err := recorder.Record(ctx, first, event); err != nil {
				t.Fatal(err)
			}
		}
	}

	options := usagestats.BackfillOptions{BatchSize: 1, Pause: time.Millisecond, MaxBatches: 1}
	if err := recorder.Backfill(ctx, options); err != nil {
		t.Fatal(err)
	}
	state, err := db.UsageBackfillState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	ordered := []string{first.ID, second.ID}
	sort.Strings(ordered)
	if state.Completed || state.Cursor != ordered[0] {
		t.Fatalf("first backfill state = %+v, want cursor %s incomplete", state, ordered[0])
	}
	if err := recorder.Backfill(ctx, options); err != nil {
		t.Fatal(err)
	}
	state, err = db.UsageBackfillState(ctx)
	if err != nil || state.Completed || state.Cursor != ordered[1] {
		t.Fatalf("second backfill state = %+v, err %v", state, err)
	}
	if err := recorder.Backfill(ctx, options); err != nil {
		t.Fatal(err)
	}
	state, err = db.UsageBackfillState(ctx)
	if err != nil || !state.Completed || state.Cursor != ordered[1] {
		t.Fatalf("completed backfill state = %+v, err %v", state, err)
	}

	// Running the completed backfill again changes nothing.
	if err := recorder.Backfill(ctx, options); err != nil {
		t.Fatal(err)
	}
	if got := usageRowCount(t, db, "usage_turns"); got != 2 {
		t.Fatalf("usage_turns after backfill = %d, want 2", got)
	}
	if got := usageRowCount(t, db, "usage_requests"); got != 2 {
		t.Fatalf("usage_requests after backfill = %d, want 2 recent rows", got)
	}
	var dailyTurns, dailyInput, dailyOutput int64
	if err := db.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(turn_count), 0), COALESCE(SUM(input_tokens), 0),
		COALESCE(SUM(output_tokens), 0) FROM usage_daily`).Scan(&dailyTurns, &dailyInput, &dailyOutput); err != nil {
		t.Fatal(err)
	}
	if dailyTurns != 2 || dailyInput != 50 || dailyOutput != 20 {
		t.Fatalf("backfill daily = turns %d input %d output %d", dailyTurns, dailyInput, dailyOutput)
	}
	var model, outcome string
	if err := db.db.QueryRowContext(ctx, `SELECT model, outcome FROM usage_turns WHERE session_id = ?`, first.ID).
		Scan(&model, &outcome); err != nil {
		t.Fatal(err)
	}
	if model != "backfill-context-model" || outcome != store.UsageOutcomeCompleted {
		t.Fatalf("preserved realtime turn = model %q outcome %q", model, outcome)
	}
}

func createBackfillSession(t *testing.T, db *Store, ctx context.Context, at time.Time, label string) (store.AgentSession, []store.AgentSessionEvent) {
	t.Helper()
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: "user_usage",
		WorkspaceID:     "ws_backfill",
		AgentID:         "agent_backfill",
		Provider:        "codex",
		Model:           "requested-model",
		Prompt:          label,
		Source:          store.SessionSourceChat,
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err = db.StartAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	contextEvent := store.AgentSessionEvent{
		ID:        "evt_context_" + session.ID,
		SessionID: session.ID,
		At:        at.Add(time.Second).Format(time.RFC3339Nano),
		Label:     store.ProcessLabelModelRequestUsage,
		Level:     "info",
		Metadata:  &store.AgentSessionEventMetadata{ContextUsage: &store.AgentContextUsage{Model: "backfill-context-model"}},
	}
	requestEvent := store.AgentSessionEvent{
		ID:        "evt_request_" + session.ID,
		SessionID: session.ID,
		At:        at.Add(2 * time.Second).Format(time.RFC3339Nano),
		Label:     store.ProcessLabelModelRequestUsage,
		Level:     "info",
		Metadata: &store.AgentSessionEventMetadata{RequestUsage: &store.ModelRequestUsage{
			RequestID: "request_" + session.ID, InputTokens: 20, OutputTokens: 10, GenerationMs: 500,
		}},
	}
	oldRequest := store.AgentSessionEvent{
		ID:        "evt_old_request_" + session.ID,
		SessionID: session.ID,
		At:        at.AddDate(0, 0, -100).Format(time.RFC3339Nano),
		Label:     store.ProcessLabelModelRequestUsage,
		Level:     "info",
		Metadata: &store.AgentSessionEventMetadata{RequestUsage: &store.ModelRequestUsage{
			RequestID: "old_request_" + session.ID, InputTokens: 5, OutputTokens: 1,
		}},
	}
	turnEvent := store.AgentSessionEvent{
		ID:        "evt_turn_" + session.ID,
		SessionID: session.ID,
		At:        at.Add(3 * time.Second).Format(time.RFC3339Nano),
		Label:     store.EventLabelCodexTurnEnd,
		Level:     "info",
		Metadata: &store.AgentSessionEventMetadata{TurnUsage: &store.AgentTurnUsage{
			DurationMs: 3_000, InputTokens: 25, OutputTokens: 10,
		}},
	}
	events := []store.AgentSessionEvent{contextEvent, requestEvent, oldRequest, turnEvent}
	for _, event := range events {
		if err := db.AppendAgentSessionEvent(ctx, event); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.CompleteAgentSession(ctx, session.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	return session, events
}

func usageTurnForTest(sessionID, inputID, startedAt string) store.UsageTurn {
	return store.UsageTurn{
		UsageReported:  true,
		SessionID:      sessionID,
		InputID:        inputID,
		UserID:         "user_usage",
		WorkspaceID:    "ws_usage",
		DeviceID:       "dev_usage",
		Entry:          store.UsageEntryChat,
		Runtime:        "claude",
		ProfileID:      "profile_usage",
		ProviderLabel:  "Claude local",
		RequestedModel: "requested-model",
		Model:          "served-model",
		StartedAt:      startedAt,
		EndedAt:        startedAt,
		DurationMs:     1_000,
		CostSource:     store.UsageCostUnknown,
		Outcome:        store.UsageOutcomeCompleted,
	}
}

func usageRowCount(t *testing.T, db *Store, table string) int {
	t.Helper()
	var count int
	if err := db.db.QueryRow(`SELECT count(*) FROM ` + table).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}
