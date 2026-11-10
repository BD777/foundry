package usagestats

import (
	"context"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type recorderStore struct {
	sessions map[string]store.AgentSession
	model    string
	records  []store.UsageRecord
}

func (s *recorderStore) GetAgentSessionSummary(_ context.Context, id string) (store.AgentSession, error) {
	session, ok := s.sessions[id]
	if !ok {
		return store.AgentSession{}, store.ErrNotFound
	}
	return session, nil
}

func (s *recorderStore) AgentSessionEventWindow(context.Context, string, string, int) ([]store.AgentSessionEvent, string, error) {
	return nil, "", nil
}

func (s *recorderStore) ListAgentSessionThreadRecords(context.Context, string, string) ([]store.AgentSession, error) {
	return nil, nil
}

func (s *recorderStore) ListIssueExecutionRecords(context.Context, string, string, int) ([]store.AgentSession, error) {
	return nil, nil
}

func (s *recorderStore) AgentSessionEventWindowSpan(context.Context, string, string, int) ([]store.AgentSessionEvent, string, string, error) {
	return nil, "", "", nil
}

func (s *recorderStore) AgentSessionEventsAfter(context.Context, string, string, int) ([]store.AgentSessionEvent, string, bool, error) {
	return nil, "", false, nil
}

func (s *recorderStore) RecordUsage(_ context.Context, record store.UsageRecord) error {
	s.records = append(s.records, record)
	return nil
}

func (s *recorderStore) UsageContextModel(context.Context, string, string) (string, error) {
	return s.model, nil
}

func (s *recorderStore) DeleteUsageRequestsBefore(context.Context, time.Time) (int64, error) {
	return 0, nil
}

func (s *recorderStore) UsageBackfillState(context.Context) (store.UsageBackfillState, error) {
	return store.UsageBackfillState{}, nil
}

func (s *recorderStore) UsageBackfillSessionIDs(context.Context, string, int) ([]string, error) {
	return nil, nil
}

func (s *recorderStore) UsageSessionEvents(context.Context, string) ([]store.AgentSessionEvent, error) {
	return nil, nil
}

func (s *recorderStore) SaveUsageBackfillState(context.Context, string, bool) error {
	return nil
}

func (s *recorderStore) UsageTurnAggregates(context.Context, store.UsageTurnAggregateQuery) ([]store.UsageTurnAggregate, error) {
	return nil, nil
}

func (s *recorderStore) UsageRequestRows(context.Context, store.UsageRequestRowQuery) ([]store.UsageRequestRow, error) {
	return nil, nil
}

func TestClassifyUsageEntry(t *testing.T) {
	ctx := context.Background()
	st := &recorderStore{sessions: map[string]store.AgentSession{
		"chat_parent": {
			ID:     "chat_parent",
			Source: store.SessionSourceChat,
		},
		"assistant_parent": {
			ID: "assistant_parent",
		},
		"issue_parent": {
			ID:      "issue_parent",
			Source:  store.SessionSourceIssue,
			IssueID: "iss_1",
		},
	}}
	assistantSessions := map[string]bool{
		"assistant_direct": true,
		"assistant_parent": true,
	}
	roleOf := func(_ context.Context, session store.AgentSession) string {
		if assistantSessions[session.ID] {
			return store.AgentSessionRolePersonalAgent
		}
		return session.Role
	}
	tests := []struct {
		name    string
		session store.AgentSession
		want    string
	}{
		{name: "chat", session: store.AgentSession{Source: store.SessionSourceChat}, want: store.UsageEntryChat},
		{name: "chat child", session: store.AgentSession{Source: store.SessionSourceAgent, ParentSessionID: "chat_parent"}, want: store.UsageEntryChatChild},
		{name: "assistant", session: store.AgentSession{ID: "assistant_direct"}, want: store.UsageEntryAssistant},
		{name: "assistant helper", session: store.AgentSession{Source: store.SessionSourceAgent, ParentSessionID: "assistant_parent"}, want: store.UsageEntryAssistantHelper},
		{name: "issue", session: store.AgentSession{Source: store.SessionSourceIssue, Role: store.AgentSessionRoleIssueExecution, IssueID: "iss_1"}, want: store.UsageEntryIssue},
		{name: "utility", session: store.AgentSession{Source: store.SessionSourceMaintenance}, want: store.UsageEntryUtility},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := ClassifyEntry(ctx, test.session, st, roleOf)
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Fatalf("entry = %q, want %q", got, test.want)
			}
		})
	}
}

func TestRecorderRecordsTurnAndRequestFromEvents(t *testing.T) {
	ctx := context.Background()
	cost := 0.42
	reasoning := int64(7)
	requests := int64(2)
	modelRequests := store.AgentTurnUsage{
		DurationMs:       2_000,
		Outcome:          store.UsageOutcomeCompleted,
		Model:            "turn-served-model",
		ModelMs:          1_500,
		TtftMs:           250,
		TimingEstimated:  true,
		InputTokens:      300,
		CacheReadTokens:  200,
		CacheWriteTokens: 50,
		OutputTokens:     80,
		ReasoningTokens:  &reasoning,
		ModelRequests:    &requests,
		CostUSD:          &cost,
	}
	st := &recorderStore{model: "provider-served-model", sessions: map[string]store.AgentSession{}}
	recorder := New(st, nil)
	session := store.AgentSession{
		ID:              "sess_usage",
		WorkspaceID:     "ws_usage",
		DeviceID:        "dev_usage",
		Provider:        "claude",
		ProfileID:       "profile_usage",
		ProfileLabel:    "Claude local",
		Model:           "requested-model",
		CreatedByUserID: "user_usage",
		Source:          store.SessionSourceChat,
		Input:           store.SessionInput{ID: "input_usage"},
		StartedAt:       "2026-11-10T01:00:00Z",
		Status:          "running",
	}
	turnEvent := store.AgentSessionEvent{
		ID:        "evt_turn",
		SessionID: session.ID,
		At:        "2026-11-10T01:00:02Z",
		Level:     "info",
		Metadata:  &store.AgentSessionEventMetadata{TurnUsage: &modelRequests},
	}
	if err := recorder.Record(ctx, session, turnEvent); err != nil {
		t.Fatal(err)
	}
	if len(st.records) != 1 || st.records[0].Turn == nil {
		t.Fatalf("turn records = %+v", st.records)
	}
	turn := st.records[0].Turn
	if turn.InputID != "input_usage" || turn.Model != "turn-served-model" ||
		turn.RequestedModel != "requested-model" || turn.InputTokens != 300 ||
		turn.ReasoningTokens != 7 || turn.ModelRequests != 2 || turn.CostSource != store.UsageCostReported ||
		turn.Outcome != store.UsageOutcomeCompleted || turn.Entry != store.UsageEntryChat {
		t.Fatalf("turn = %+v", turn)
	}

	request := store.ModelRequestUsage{
		RequestID:        "request_usage",
		Model:            "request-served-model",
		InputTokens:      40,
		CacheReadTokens:  10,
		CacheWriteTokens: 5,
		OutputTokens:     12,
		FirstTokenMs:     100,
		GenerationMs:     500,
		RequestMs:        700,
		TimingEstimated:  true,
	}
	requestEvent := store.AgentSessionEvent{
		ID:        "evt_request",
		SessionID: session.ID,
		At:        "2026-11-10T01:00:01Z",
		Level:     "info",
		Metadata:  &store.AgentSessionEventMetadata{RequestUsage: &request},
	}
	if err := recorder.Record(ctx, session, requestEvent); err != nil {
		t.Fatal(err)
	}
	if len(st.records) != 2 || len(st.records[1].Requests) != 1 {
		t.Fatalf("request records = %+v", st.records)
	}
	got := st.records[1].Requests[0]
	if got.RequestID != "request_usage" || got.Model != "request-served-model" ||
		got.FirstTokenMs != 100 || got.GenerationMs != 500 || got.RequestMs != 700 || !got.TimingEstimated {
		t.Fatalf("request = %+v", got)
	}
}

func TestRecorderRecordsFailedAndCanceledTurnsWithoutUsage(t *testing.T) {
	for _, test := range []struct {
		name    string
		status  string
		outcome string
	}{
		{name: "failed", status: "failed", outcome: store.UsageOutcomeFailed},
		{name: "canceled", status: "canceled", outcome: store.UsageOutcomeCanceled},
	} {
		t.Run(test.name, func(t *testing.T) {
			st := &recorderStore{sessions: map[string]store.AgentSession{}}
			recorder := New(st, nil)
			session := store.AgentSession{
				ID:          "sess_terminal",
				WorkspaceID: "ws_terminal",
				DeviceID:    "dev_terminal",
				Provider:    "codex",
				Input:       store.SessionInput{ID: "input_terminal"},
				StartedAt:   "2026-11-10T02:00:00Z",
				CompletedAt: "2026-11-10T02:00:03Z",
				Status:      test.status,
				Error:       "timed out",
			}
			err := recorder.Record(context.Background(), session, store.AgentSessionEvent{
				SessionID: session.ID,
				At:        session.CompletedAt,
			})
			if err != nil {
				t.Fatal(err)
			}
			if len(st.records) != 1 || st.records[0].Turn == nil {
				t.Fatalf("terminal records = %+v", st.records)
			}
			turn := st.records[0].Turn
			if turn.Outcome != test.outcome || turn.DurationMs != 3_000 ||
				turn.InputTokens != 0 || turn.OutputTokens != 0 || turn.ErrorClass != "timeout" {
				t.Fatalf("terminal turn = %+v", turn)
			}
		})
	}
}

func TestRecorderUsesContextUsageModel(t *testing.T) {
	st := &recorderStore{model: "older-model", sessions: map[string]store.AgentSession{}}
	recorder := New(st, nil)
	session := store.AgentSession{
		ID:          "sess_model",
		WorkspaceID: "ws_model",
		DeviceID:    "dev_model",
		Provider:    "claude",
		Model:       "requested-model",
		Input:       store.SessionInput{ID: "input_model"},
		StartedAt:   "2026-11-10T03:00:00Z",
		Status:      "running",
	}
	usage := store.AgentTurnUsage{DurationMs: 1_000, InputTokens: 1, OutputTokens: 2}
	err := recorder.Record(context.Background(), session, store.AgentSessionEvent{
		SessionID: session.ID,
		At:        "2026-11-10T03:00:01Z",
		Metadata: &store.AgentSessionEventMetadata{
			TurnUsage:    &usage,
			ContextUsage: &store.AgentContextUsage{Model: "claude-context-model"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(st.records) != 1 || st.records[0].Turn == nil || st.records[0].Turn.Model != "claude-context-model" {
		t.Fatalf("recorded model = %+v", st.records)
	}
}

func TestBackfillInfersOldTurnOutcomeAndModel(t *testing.T) {
	st := &recorderStore{sessions: map[string]store.AgentSession{}}
	recorder := New(st, nil)
	inputID := "input_backfill"
	session := store.AgentSession{
		ID:          "sess_backfill",
		WorkspaceID: "ws_backfill",
		DeviceID:    "dev_backfill",
		Provider:    "claude",
		Input:       store.SessionInput{ID: inputID, At: "2026-11-10T04:00:00Z"},
		StartedAt:   "2026-11-10T04:00:00Z",
		CompletedAt: "2026-11-10T04:00:04Z",
		Status:      "failed",
		Error:       "worker timed out",
	}
	events := []store.AgentSessionEvent{
		{
			ID:        store.SessionInputEventID(inputID),
			SessionID: session.ID,
			At:        "2026-11-10T04:00:00Z",
			Label:     store.EventLabelUserMessage,
			Level:     "info",
		},
		{
			ID:        "evt_backfill_context",
			SessionID: session.ID,
			At:        "2026-11-10T04:00:01Z",
			Metadata:  &store.AgentSessionEventMetadata{ContextUsage: &store.AgentContextUsage{Model: "old-context-model"}},
		},
		{
			ID:        "evt_backfill_turn",
			SessionID: session.ID,
			At:        "2026-11-10T04:00:03Z",
			Level:     "info",
			Metadata:  &store.AgentSessionEventMetadata{TurnUsage: &store.AgentTurnUsage{DurationMs: 3_000, InputTokens: 10, OutputTokens: 4}},
		},
	}
	if err := recorder.backfillSession(context.Background(), session, events); err != nil {
		t.Fatal(err)
	}
	if len(st.records) != 1 || st.records[0].Turn == nil {
		t.Fatalf("backfill records = %+v", st.records)
	}
	turn := st.records[0].Turn
	if turn.Outcome != store.UsageOutcomeFailed || turn.Model != "old-context-model" ||
		turn.InputID != inputID || turn.ErrorClass != "timeout" || !turn.Backfill {
		t.Fatalf("backfilled turn = %+v", turn)
	}
}
