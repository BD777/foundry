package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The newest window of a long chat carries the usage its status line
// reads: the newest report of the context's size, each turn's usage and
// each compaction. A fire of a removed timer keeps its turn's usage
// without the fire.
func TestWindowedReadCarriesOlderUsage(t *testing.T) {
	db := newEmptyTestStore(t)
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_usage", Label: "Usage Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_usage", Name: "Usage", LocalPath: t.TempDir()},
		Agents: []store.AgentProjection{{
			ID: "agent_usage", WorkspaceID: "ws_usage", DeviceID: "dev_usage", DeviceLabel: "Usage Device",
			Provider: "claude", Status: "healthy", AuthMode: "local_config", SecretStored: "local",
			ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_usage", AgentID: "agent_usage", Provider: "claude", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	tokens := func(value int64) *int64 { return &value }
	cost := 0.25
	usage := func(input int64) *store.AgentTurnUsage {
		return &store.AgentTurnUsage{DurationMs: 2000, InputTokens: input, OutputTokens: 20, CostUSD: &cost}
	}
	noTimers := []store.AgentScheduledTask{}
	older := []store.AgentSessionEvent{
		{ID: "evt_context_old", Label: "Model request usage", Detail: "msg_1", Metadata: &store.AgentSessionEventMetadata{
			RequestUsage: &store.ModelRequestUsage{RequestID: "msg_1", InputTokens: 900},
			ContextUsage: &store.AgentContextUsage{InputTokens: tokens(900), ContextWindow: tokens(200_000), Model: "claude-opus-5-5"},
		}},
		{ID: "evt_turn_1", Label: "Claude Agent SDK finished", Detail: "/tmp/one/result.md", Metadata: &store.AgentSessionEventMetadata{TurnUsage: usage(1000)}},
		{ID: "evt_fire_gone", Label: "Scheduled task fired", Detail: "patrol", Metadata: &store.AgentSessionEventMetadata{
			TimerFire: &store.AgentSessionTimerFire{ID: "gone_timer", Origin: "scheduled", Response: "the fire's answer"},
			TurnUsage: usage(500),
		}},
		{ID: "evt_timers_empty", Label: "Scheduled tasks updated", Metadata: &store.AgentSessionEventMetadata{TimerSnapshot: &noTimers}},
		{ID: "evt_compacted", Label: "Model request usage", Metadata: &store.AgentSessionEventMetadata{
			ContextUsage: &store.AgentContextUsage{InputTokens: tokens(30_000), Compaction: &store.AgentContextCompaction{Trigger: "auto", PreTokens: tokens(180_000)}},
		}},
		{ID: "evt_context_new", Label: "Model request usage", Detail: "msg_2", Metadata: &store.AgentSessionEventMetadata{
			RequestUsage: &store.ModelRequestUsage{RequestID: "msg_2", InputTokens: 32_000},
			ContextUsage: &store.AgentContextUsage{InputTokens: tokens(32_000), ContextWindow: tokens(200_000), Model: "claude-opus-5-5"},
		}},
		{ID: "evt_turn_2", Label: "Claude Agent SDK finished", Detail: "/tmp/two/result.md", Metadata: &store.AgentSessionEventMetadata{TurnUsage: usage(2000)}},
	}
	base := time.Now().UTC().Add(time.Minute)
	for index := range 3 {
		older = append(older, store.AgentSessionEvent{ID: fmt.Sprintf("evt_recent_%d", index), Label: "Response stream", Detail: "recent"})
	}
	for index, event := range older {
		event.SessionID = session.ID
		event.Level = "info"
		event.At = base.Add(time.Duration(index) * time.Second).Format(time.RFC3339Nano)
		if err := db.AppendAgentSessionEvent(ctx, event); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db)
	var sessions []stateWindowForTest
	if err := json.Unmarshal(getRawForTest(t, server, "/api/agent-session-threads/"+session.ID+"?workspaceId=ws_usage&eventsLimit=3", http.StatusOK), &sessions); err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 {
		t.Fatalf("thread = %d sessions", len(sessions))
	}
	want := []string{"evt_turn_1", "evt_fire_gone", "evt_timers_empty", "evt_compacted", "evt_context_new", "evt_turn_2"}
	if got := windowEventIDs(sessions[0].StateEvents); !slices.Equal(got, want) {
		t.Fatalf("state events = %v\nwant %v", got, want)
	}
	byID := map[string]store.AgentSessionEvent{}
	for _, event := range sessions[0].StateEvents {
		byID[event.ID] = event
	}
	if context := byID["evt_context_new"].Metadata.ContextUsage; context == nil || *context.InputTokens != 32_000 || *context.ContextWindow != 200_000 || context.Model != "claude-opus-5-5" {
		t.Fatalf("context = %+v", byID["evt_context_new"].Metadata)
	}
	if turn := byID["evt_turn_1"].Metadata.TurnUsage; turn == nil || turn.InputTokens != 1000 || turn.CostUSD == nil || *turn.CostUSD != cost {
		t.Fatalf("turn usage = %+v", byID["evt_turn_1"].Metadata)
	}
	if fire := byID["evt_fire_gone"]; fire.Metadata.TimerFire != nil || fire.Metadata.TurnUsage == nil || fire.Metadata.TurnUsage.InputTokens != 500 {
		t.Fatalf("removed timer's fire = %+v", fire.Metadata)
	}
	if compaction := byID["evt_compacted"].Metadata.ContextUsage; compaction == nil || compaction.Compaction == nil || compaction.Compaction.Trigger != "auto" {
		t.Fatalf("compaction = %+v", byID["evt_compacted"].Metadata)
	}
}
