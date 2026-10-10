package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type stateWindowForTest struct {
	ID           string                    `json:"id"`
	Events       []store.AgentSessionEvent `json:"events"`
	EventsBefore *string                   `json:"eventsBefore"`
	StateEvents  []store.AgentSessionEvent `json:"stateEvents"`
}

// The newest window of a long chat also carries the older events its side
// panel reads: the latest timer and background snapshots, recorded files,
// a subagent's start and latest report and the timer's fires, without the
// answers and prompts they hold. A snapshot the window replaces, a fire of
// a removed timer, a page of older events and an unwindowed read carry
// none of it.
func TestWindowedReadCarriesOlderSessionState(t *testing.T) {
	db := newEmptyTestStore(t)
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_state", Label: "State Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_state", Name: "State", LocalPath: t.TempDir()},
		Agents: []store.AgentProjection{{
			ID: "agent_state", WorkspaceID: "ws_state", DeviceID: "dev_state", DeviceLabel: "State Device",
			Provider: "codex", Status: "healthy", AuthMode: "local_config", SecretStored: "local",
			ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_state", AgentID: "agent_state", Provider: "codex", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	const (
		subagentPrompt = "a very long subagent prompt"
		subagentAnswer = "the subagent's whole answer"
		fireAnswer     = "the scheduled turn's answer"
	)
	timers := func(taskIDs ...string) *store.AgentSessionEventMetadata {
		tasks := []store.AgentScheduledTask{}
		for _, id := range taskIDs {
			tasks = append(tasks, store.AgentScheduledTask{ID: id, Kind: "cron", Schedule: "28,58 * * * *", Recurring: true, Prompt: "patrol"})
		}
		return &store.AgentSessionEventMetadata{TimerSnapshot: &tasks}
	}
	background := []store.AgentBackgroundTask{{ID: "bg1", Kind: "command", Description: "tests", Status: "running"}}
	base := time.Now().UTC().Add(time.Minute)
	record := func(index int, event store.AgentSessionEvent) {
		t.Helper()
		event.SessionID = session.ID
		event.At = base.Add(time.Duration(index) * time.Second).Format(time.RFC3339Nano)
		if event.Level == "" {
			event.Level = "info"
		}
		if err := db.AppendAgentSessionEvent(ctx, event); err != nil {
			t.Fatal(err)
		}
	}
	older := []store.AgentSessionEvent{
		{ID: "evt_timers_removed", Label: "Scheduled tasks updated", Metadata: timers("old_timer")},
		{ID: "evt_fire_removed", Label: "Scheduled task fired", Metadata: &store.AgentSessionEventMetadata{TimerFire: &store.AgentSessionTimerFire{ID: "old_timer", Origin: "scheduled", Response: fireAnswer, CompletedAt: "2026-10-10T06:28:00Z"}}},
		{ID: "evt_timers", Label: "Scheduled tasks updated", Detail: "every 30 minutes", Metadata: timers("9b17c9d2")},
		{ID: "evt_fire", Label: "Scheduled task fired", Detail: "patrol", Metadata: &store.AgentSessionEventMetadata{TimerFire: &store.AgentSessionTimerFire{ID: "9b17c9d2", Origin: "scheduled", Prompt: "patrol", Response: fireAnswer, CompletedAt: "2026-10-10T06:58:00Z"}}},
		{ID: "evt_background", Label: "Background tasks updated", Metadata: &store.AgentSessionEventMetadata{BackgroundTaskSnapshot: &background}},
		{ID: "evt_file", Label: "Recorded file", Detail: "notes.md", Metadata: &store.AgentSessionEventMetadata{SessionFile: &store.SessionFileRecord{Path: "/repo/notes.md", Op: "created", Origin: "tool"}}},
		{ID: "evt_subagent", Label: "Starting subtask", Detail: "Review the change", Metadata: &store.AgentSessionEventMetadata{TaskID: "agent_1", TaskType: "local_agent", ToolUseID: "toolu_1", Prompt: subagentPrompt}},
		{ID: "evt_subagent_end", Label: "Subtask completed", Detail: subagentAnswer, Metadata: &store.AgentSessionEventMetadata{TaskID: "agent_1", ToolUseID: "toolu_1", SubagentUsage: &store.SubagentUsage{TotalTokens: 1200, ToolUses: 3}}},
		{ID: "evt_answer", Label: "Response stream", Detail: "an answer from long ago"},
	}
	for index, event := range older {
		record(index, event)
	}
	for index := range 5 {
		record(len(older)+index, store.AgentSessionEvent{ID: fmt.Sprintf("evt_recent_%d", index), Label: "Response stream", Detail: "recent"})
	}
	server := NewServer(db)
	threadPath := "/api/agent-session-threads/" + session.ID + "?workspaceId=ws_state"
	readThread := func(query string) stateWindowForTest {
		t.Helper()
		var sessions []stateWindowForTest
		if err := json.Unmarshal(getRawForTest(t, server, threadPath+query, http.StatusOK), &sessions); err != nil {
			t.Fatal(err)
		}
		if len(sessions) != 1 {
			t.Fatalf("thread = %d sessions, want 1", len(sessions))
		}
		return sessions[0]
	}

	recent := readThread("&eventsLimit=3")
	if recent.EventsBefore == nil || len(recent.Events) != 3 {
		t.Fatalf("window = %v; want the newest 3 events and a cursor", windowEventIDs(recent.Events))
	}
	want := []string{"evt_timers", "evt_fire", "evt_background", "evt_file", "evt_subagent", "evt_subagent_end"}
	if got := windowEventIDs(recent.StateEvents); !slices.Equal(got, want) {
		t.Fatalf("state events = %v\nwant %v", got, want)
	}
	raw, err := json.Marshal(recent.StateEvents)
	if err != nil {
		t.Fatal(err)
	}
	for _, heavy := range []string{subagentPrompt, subagentAnswer, fireAnswer, "an answer from long ago"} {
		if strings.Contains(string(raw), heavy) {
			t.Fatalf("state events carry %q: %s", heavy, raw)
		}
	}
	byID := map[string]store.AgentSessionEvent{}
	for _, event := range recent.StateEvents {
		byID[event.ID] = event
	}
	if tasks := byID["evt_timers"].Metadata.TimerSnapshot; tasks == nil || len(*tasks) != 1 || (*tasks)[0].ID != "9b17c9d2" || (*tasks)[0].Prompt != "patrol" {
		t.Fatalf("timer snapshot = %+v", byID["evt_timers"].Metadata)
	}
	if fire := byID["evt_fire"].Metadata.TimerFire; fire == nil || fire.ID != "9b17c9d2" || fire.CompletedAt != "2026-10-10T06:58:00Z" {
		t.Fatalf("timer fire = %+v", byID["evt_fire"].Metadata)
	}
	if start := byID["evt_subagent"]; start.Detail != "Review the change" || start.Metadata.TaskType != "local_agent" || start.Metadata.TaskID != "agent_1" || start.Metadata.ToolUseID != "toolu_1" {
		t.Fatalf("subagent start = %+v %+v", start, start.Metadata)
	}
	if end := byID["evt_subagent_end"]; end.Label != "Subtask completed" || end.Metadata.SubagentUsage == nil || end.Metadata.SubagentUsage.TotalTokens != 1200 {
		t.Fatalf("subagent end = %+v %+v", end, end.Metadata)
	}
	if file := byID["evt_file"].Metadata.SessionFile; file == nil || file.Path != "/repo/notes.md" {
		t.Fatalf("recorded file = %+v", byID["evt_file"].Metadata)
	}

	// The session read's newest window carries them too; a page of older
	// events and an unwindowed read do not.
	var direct stateWindowForTest
	if err := json.Unmarshal(getRawForTest(t, server, "/api/agent-sessions/"+session.ID+"?eventsLimit=3", http.StatusOK), &direct); err != nil {
		t.Fatal(err)
	}
	if got := windowEventIDs(direct.StateEvents); !slices.Equal(got, want) {
		t.Fatalf("session read state events = %v; want %v", got, want)
	}
	var page stateWindowForTest
	if err := json.Unmarshal(getRawForTest(t, server, "/api/agent-sessions/"+session.ID+"?eventsLimit=3&eventsBefore="+url.QueryEscape(*recent.EventsBefore), http.StatusOK), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Events) != 3 || page.StateEvents != nil {
		t.Fatalf("page = %v with state %v; want 3 events and no state", windowEventIDs(page.Events), windowEventIDs(page.StateEvents))
	}
	if whole := readThread(""); whole.StateEvents != nil {
		t.Fatalf("unwindowed read carries state events %v", windowEventIDs(whole.StateEvents))
	}

	// A newer snapshot in the window replaces the older one, whose fires
	// no longer show.
	record(len(older)+5, store.AgentSessionEvent{ID: "evt_timers_cleared", Label: "Scheduled tasks updated", Metadata: timers()})
	want = []string{"evt_background", "evt_file", "evt_subagent", "evt_subagent_end"}
	if got := windowEventIDs(readThread("&eventsLimit=3").StateEvents); !slices.Equal(got, want) {
		t.Fatalf("state events once the window replaces the timers = %v; want %v", got, want)
	}
}
