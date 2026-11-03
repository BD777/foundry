package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type stateWindowForTest struct {
	ID           string                    `json:"id"`
	Events       []store.AgentSessionEvent `json:"events"`
	EventsBefore *string                   `json:"eventsBefore"`
	Panel        *store.AgentSessionPanel  `json:"panel"`
}

// The newest window of a long chat carries its side panel, derived on the
// server from the session's state, events older than the window included:
// the latest timer and background snapshots, recorded files, a subagent's
// start and end and the timer's runs, without the answers and prompts the
// transcript holds. Every window size reads the same panel; a page of older
// events and an unwindowed read carry none.
func TestWindowedReadCarriesTheSessionPanel(t *testing.T) {
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
	if recent.EventsBefore == nil || len(recent.Events) != 3 || recent.Panel == nil {
		t.Fatalf("window = %v, panel %v; want the newest 3 events, a cursor and the panel", windowEventIDs(recent.Events), recent.Panel)
	}
	raw, err := json.Marshal(recent.Panel)
	if err != nil {
		t.Fatal(err)
	}
	for _, heavy := range []string{subagentPrompt, subagentAnswer, "an answer from long ago"} {
		if strings.Contains(string(raw), heavy) {
			t.Fatalf("panel carries %q: %s", heavy, raw)
		}
	}
	panel := recent.Panel
	if len(panel.Timers) != 1 || panel.Timers[0].Task.ID != "9b17c9d2" || panel.Timers[0].Task.Prompt != "patrol" {
		t.Fatalf("timers = %+v", panel.Timers)
	}
	if runs := panel.Timers[0].Runs; len(runs) != 1 || runs[0].CompletedAt != "2026-10-10T06:58:00Z" || runs[0].Response != fireAnswer {
		t.Fatalf("timer runs = %+v", runs)
	}
	if want := []store.AgentSessionPanelSubagent{{ID: "evt_subagent", TaskID: "agent_1", ToolUseID: "toolu_1", Detail: "Review the change", Status: "completed",
		Usage: &store.SubagentUsage{TotalTokens: 1200, ToolUses: 3}}}; encodedJSON(panel.Subagents) != encodedJSON(want) {
		t.Fatalf("subagents = %+v; want %+v", panel.Subagents, want)
	}
	if len(panel.Background) != 0 || len(panel.Files) != 1 || panel.Files[0].Path != "/repo/notes.md" || !panel.Focus {
		t.Fatalf("panel = %+v", panel)
	}
	encoded := func(panel *store.AgentSessionPanel) string {
		raw, _ := json.Marshal(panel)
		return string(raw)
	}
	if wide := readThread("&eventsLimit=1000"); encoded(wide.Panel) != encoded(panel) {
		t.Fatalf("a wider window reads panel %s; want %s", encoded(wide.Panel), encoded(panel))
	}

	// The session read's newest window carries it too; a page of older
	// events and an unwindowed read do not.
	var direct stateWindowForTest
	if err := json.Unmarshal(getRawForTest(t, server, "/api/agent-sessions/"+session.ID+"?eventsLimit=3", http.StatusOK), &direct); err != nil {
		t.Fatal(err)
	}
	if encoded(direct.Panel) != encoded(panel) {
		t.Fatalf("session read panel = %s; want %s", encoded(direct.Panel), encoded(panel))
	}
	var page stateWindowForTest
	if err := json.Unmarshal(getRawForTest(t, server, "/api/agent-sessions/"+session.ID+"?eventsLimit=3&eventsBefore="+url.QueryEscape(*recent.EventsBefore), http.StatusOK), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Events) != 3 || page.Panel != nil {
		t.Fatalf("page = %v with panel %v; want 3 events and no panel", windowEventIDs(page.Events), page.Panel)
	}
	if whole := readThread(""); whole.Panel != nil {
		t.Fatalf("unwindowed read carries a panel %+v", whole.Panel)
	}

	// A newer snapshot replaces the older one: no timer is left.
	record(len(older)+5, store.AgentSessionEvent{ID: "evt_timers_cleared", Label: "Scheduled tasks updated", Metadata: timers()})
	if cleared := readThread("&eventsLimit=3").Panel; len(cleared.Timers) != 0 || len(cleared.Subagents) != 1 {
		t.Fatalf("panel once the timers are cleared = %+v", cleared)
	}
}

func encodedJSON(value any) string {
	raw, _ := json.Marshal(value)
	return string(raw)
}
