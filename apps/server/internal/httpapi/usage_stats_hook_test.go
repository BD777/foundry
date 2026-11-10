package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/usagestats"
)

func TestUsageStatsHookRecordsDaemonEvents(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "foundry.db")
	backing, err := sqlitestore.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = backing.Close() })
	registerQueueDevice(t, backing, "claude")
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_queue",
		AgentID:     "agent_queue",
		Provider:    "claude",
		Model:       "requested-model",
		Prompt:      "measure this turn",
		Source:      store.SessionSourceChat,
	})
	if err != nil {
		t.Fatal(err)
	}
	if session, err = backing.StartAgentSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	connection := newDaemonConnection(server.hub, nil)
	t.Cleanup(connection.endLifetime)

	contextEvent := store.AgentSessionEvent{
		ID:        "evt_usage_context",
		SessionID: session.ID,
		Label:     store.ProcessLabelModelRequestUsage,
		Level:     "info",
		Metadata: &store.AgentSessionEventMetadata{
			ContextUsage: &store.AgentContextUsage{Model: "claude-observed-model"},
		},
	}
	recordDaemonEventForUsageTest(t, ctx, connection, "context", contextEvent)
	usage := store.AgentTurnUsage{
		DurationMs:       2_000,
		Outcome:          store.UsageOutcomeCompleted,
		ModelMs:          1_500,
		TtftMs:           250,
		TimingEstimated:  true,
		InputTokens:      300,
		CacheReadTokens:  200,
		CacheWriteTokens: 50,
		OutputTokens:     80,
	}
	recordDaemonEventForUsageTest(t, ctx, connection, "turn", store.AgentSessionEvent{
		ID:        "evt_usage_turn",
		SessionID: session.ID,
		Label:     store.EventLabelClaudeTurnEnd,
		Level:     "info",
		Metadata:  &store.AgentSessionEventMetadata{TurnUsage: &usage},
	})
	request := store.ModelRequestUsage{
		RequestID:       "request_hook",
		InputTokens:     40,
		OutputTokens:    12,
		FirstTokenMs:    100,
		GenerationMs:    400,
		RequestMs:       600,
		TimingEstimated: true,
	}
	recordDaemonEventForUsageTest(t, ctx, connection, "request", store.AgentSessionEvent{
		ID:        "evt_usage_request",
		SessionID: session.ID,
		Label:     store.ProcessLabelModelRequestUsage,
		Level:     "info",
		Metadata:  &store.AgentSessionEventMetadata{RequestUsage: &request},
	})
	// A worker resends after a lost acknowledgement. The event, turn and
	// request are not counted twice.
	recordDaemonEventForUsageTest(t, ctx, connection, "turn_again", store.AgentSessionEvent{
		ID:        "evt_usage_turn",
		SessionID: session.ID,
		Label:     store.EventLabelClaudeTurnEnd,
		Level:     "info",
		Metadata:  &store.AgentSessionEventMetadata{TurnUsage: &usage},
	})
	recordDaemonEventForUsageTest(t, ctx, connection, "request_again", store.AgentSessionEvent{
		ID:        "evt_usage_request",
		SessionID: session.ID,
		Label:     store.ProcessLabelModelRequestUsage,
		Level:     "info",
		Metadata:  &store.AgentSessionEventMetadata{RequestUsage: &request},
	})

	other, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	var (
		model, outcome, costSource string
		input, output, requests    int64
	)
	if err := other.QueryRowContext(ctx, `SELECT model, outcome, cost_source, input_tokens, output_tokens, model_requests
		FROM usage_turns WHERE session_id = ? AND input_id = ?`, session.ID, session.Input.ID).
		Scan(&model, &outcome, &costSource, &input, &output, &requests); err != nil {
		t.Fatal(err)
	}
	if model != "claude-observed-model" || outcome != store.UsageOutcomeCompleted ||
		costSource != store.UsageCostUnknown || input != 300 || output != 80 || requests != 0 {
		t.Fatalf("usage turn = model %q outcome %q cost %q input %d output %d requests %d",
			model, outcome, costSource, input, output, requests)
	}
	var requestModel string
	var firstToken, generation, requestMs int64
	var timingEstimated bool
	if err := other.QueryRowContext(ctx, `SELECT model, first_token_ms, generation_ms, request_ms, timing_estimated
		FROM usage_requests WHERE request_id = 'request_hook'`).
		Scan(&requestModel, &firstToken, &generation, &requestMs, &timingEstimated); err != nil {
		t.Fatal(err)
	}
	if requestModel != "claude-observed-model" || firstToken != 100 || generation != 400 || requestMs != 600 || !timingEstimated {
		t.Fatalf("usage request = model %q timing %d/%d/%d estimated %t", requestModel, firstToken, generation, requestMs, timingEstimated)
	}
	var turns, dailyTurns, requestRows int64
	if err := other.QueryRowContext(ctx, `SELECT
		(SELECT count(*) FROM usage_turns WHERE session_id = ?),
		(SELECT turn_count FROM usage_daily WHERE day = substr(?, 1, 10)),
		(SELECT count(*) FROM usage_requests WHERE request_id = 'request_hook')`,
		session.ID, session.StartedAt).Scan(&turns, &dailyTurns, &requestRows); err != nil {
		t.Fatal(err)
	}
	if turns != 1 || dailyTurns != 1 || requestRows != 1 {
		t.Fatalf("redelivery counts = turns %d daily %d requests %d", turns, dailyTurns, requestRows)
	}
}

func TestUsageStatsFailureDoesNotBlockEventOrCompletion(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "foundry.db")
	backing, err := sqlitestore.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = backing.Close() })
	registerQueueDevice(t, backing, "claude")
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_queue",
		AgentID:     "agent_queue",
		Provider:    "claude",
		Prompt:      "usage stats are a side path",
		Source:      store.SessionSourceChat,
	})
	if err != nil {
		t.Fatal(err)
	}
	if session, err = backing.StartAgentSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	server.hub.usageStats = usagestats.New(usageStoreWithWriteError{Store: backing}, server.assistant.SessionRole)
	connection := newDaemonConnection(server.hub, nil)
	t.Cleanup(connection.endLifetime)
	usage := store.AgentTurnUsage{DurationMs: 1_000, Outcome: store.UsageOutcomeCompleted}
	recordDaemonEventForUsageTest(t, ctx, connection, "turn", store.AgentSessionEvent{
		ID:        "evt_usage_failure_turn",
		SessionID: session.ID,
		Label:     store.EventLabelClaudeTurnEnd,
		Level:     "info",
		Metadata:  &store.AgentSessionEventMetadata{TurnUsage: &usage},
	})
	events, _, err := backing.AgentSessionEventWindow(ctx, session.ID, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, event := range events {
		found = found || event.ID == "evt_usage_failure_turn"
	}
	if !found {
		t.Fatal("event was not stored despite usage stats error")
	}

	payload, err := json.Marshal(wsSessionCompletedPayload{
		SessionID: session.ID,
		InputID:   session.Input.ID,
		Response:  "done",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.onSessionCompleted(ctx, wsEnvelope{
		ID: "completed", Type: wsSessionCompleteType, Payload: payload,
	}); err != nil {
		t.Fatal(err)
	}
	stored, err := backing.GetAgentSessionRecord(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != "completed" {
		t.Fatalf("session status = %q, want completed", stored.Status)
	}
	connection.replyMu.Lock()
	replies := len(connection.replies)
	connection.replyMu.Unlock()
	if replies != 2 {
		t.Fatalf("usage stats failure changed acknowledgements: %d replies, want 2", replies)
	}
}

func TestUsageStatsHookRecordsTerminalTurns(t *testing.T) {
	for _, test := range []struct {
		name    string
		error   string
		outcome string
	}{
		{name: "failed", error: "worker timed out", outcome: store.UsageOutcomeFailed},
		{name: "canceled", error: "Session was canceled", outcome: store.UsageOutcomeCanceled},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			dbPath := filepath.Join(t.TempDir(), "foundry.db")
			backing, err := sqlitestore.Open(dbPath)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = backing.Close() })
			registerQueueDevice(t, backing, "codex")
			session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{
				WorkspaceID: "ws_queue",
				AgentID:     "agent_queue",
				Provider:    "codex",
				Prompt:      "end without usage",
				Source:      store.SessionSourceChat,
			})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := backing.StartAgentSession(ctx, session.ID); err != nil {
				t.Fatal(err)
			}
			server := NewServer(backing)
			connection := newDaemonConnection(server.hub, nil)
			t.Cleanup(connection.endLifetime)
			payload, err := json.Marshal(wsSessionCompletedPayload{
				SessionID: session.ID,
				InputID:   session.Input.ID,
				Error:     test.error,
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := connection.onSessionCompleted(ctx, wsEnvelope{
				ID: "completed_" + test.name, Type: wsSessionCompleteType, Payload: payload,
			}); err != nil {
				t.Fatal(err)
			}

			other, err := sql.Open("sqlite", dbPath)
			if err != nil {
				t.Fatal(err)
			}
			defer other.Close()
			var outcome string
			var input, output int64
			if err := other.QueryRowContext(ctx, `SELECT outcome, input_tokens, output_tokens
				FROM usage_turns WHERE session_id = ? AND input_id = ?`, session.ID, session.Input.ID).
				Scan(&outcome, &input, &output); err != nil {
				t.Fatal(err)
			}
			if outcome != test.outcome || input != 0 || output != 0 {
				t.Fatalf("terminal turn = outcome %q input %d output %d", outcome, input, output)
			}
		})
	}
}

type usageStoreWithWriteError struct {
	*sqlitestore.Store
}

func (usageStoreWithWriteError) RecordUsage(context.Context, store.UsageRecord) error {
	return errors.New("synthetic usage stats failure")
}

func recordDaemonEventForUsageTest(t *testing.T, ctx context.Context, connection *daemonConnection, id string, event store.AgentSessionEvent) {
	t.Helper()
	payload, err := json.Marshal(wsSessionEventPayload{Event: event})
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.onSessionEvent(ctx, wsEnvelope{
		ID: id, Type: wsSessionEventType, Payload: payload,
	}); err != nil {
		t.Fatal(err)
	}
}
