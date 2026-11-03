package store

import (
	"encoding/json"
	"slices"
	"testing"
)

func panelEvent(id, at, label string, metadata *AgentSessionEventMetadata) AgentSessionEvent {
	return AgentSessionEvent{ID: id, SessionID: "sess_1", At: at, Label: label, Level: "info", Metadata: metadata}
}

func int64p(value int64) *int64 { return &value }

func TestPanelSubagentsFollowTheirStartAndEnd(t *testing.T) {
	session := AgentSession{ID: "sess_1", Provider: "claude", Status: "failed"}
	panel := DeriveSessionPanel(session, []AgentSessionEvent{
		{ID: "evt_start_a", At: "2026-11-03T10:00:00Z", Label: ProcessLabelStartingSubtask, Detail: "Review the change\nmore",
			Metadata: &AgentSessionEventMetadata{TaskID: "a", TaskType: SubagentTaskType, ToolUseID: "toolu_a"}},
		{ID: "evt_start_b", At: "2026-11-03T10:00:01Z", Label: ProcessLabelStartingSubtask, Detail: "Run tests",
			Metadata: &AgentSessionEventMetadata{TaskID: "b", TaskType: SubagentTaskType}},
		// A background command is no subagent.
		{ID: "evt_start_cmd", At: "2026-11-03T10:00:02Z", Label: ProcessLabelStartingSubtask, Detail: "npm test",
			Metadata: &AgentSessionEventMetadata{TaskID: "cmd", TaskType: "local_bash"}},
		{ID: "evt_end_a", At: "2026-11-03T10:01:00Z", Label: ProcessLabelSubtaskCompleted, Detail: "the whole reply",
			Metadata: &AgentSessionEventMetadata{TaskID: "a", SubagentUsage: &SubagentUsage{TotalTokens: 10}}},
	})
	want := []AgentSessionPanelSubagent{
		{ID: "evt_start_a", TaskID: "a", ToolUseID: "toolu_a", Detail: "Review the change\nmore", Status: "completed", Usage: &SubagentUsage{TotalTokens: 10}},
		// Its session failed while it ran.
		{ID: "evt_start_b", TaskID: "b", Detail: "Run tests", Status: "failed"},
	}
	got, _ := json.Marshal(panel.Subagents)
	wanted, _ := json.Marshal(want)
	if string(got) != string(wanted) {
		t.Fatalf("subagents = %s; want %s", got, wanted)
	}
	if !panel.Focus {
		t.Fatal("a session with subagents has the panel's focus")
	}
}

func TestPanelBackgroundListsRunningWorkFirst(t *testing.T) {
	snapshot := []AgentBackgroundTask{
		{ID: "done_old", Kind: "command", Description: "old", Status: "completed", StartedAt: "2026-11-03T09:00:00Z", EndedAt: "2026-11-03T09:01:00Z"},
		{ID: "run_late", Kind: "command", Description: "late", Status: "running", StartedAt: "2026-11-03T09:05:00Z"},
		{ID: "agent", Kind: "subagent", Description: "Explorer", Status: "running", StartedAt: "2026-11-03T09:00:00Z"},
		{ID: "run_early", Kind: "monitor", Description: "early", Status: "running", StartedAt: "2026-11-03T09:02:00Z", OwnerSubagentTaskID: "agent"},
		{ID: "done_new", Kind: "command", Description: "new", Status: "failed", StartedAt: "2026-11-03T09:00:00Z", EndedAt: "2026-11-03T09:06:00Z"},
	}
	events := []AgentSessionEvent{panelEvent("evt_bg", "2026-11-03T09:07:00Z", ProcessLabelBackgroundTasksSync, &AgentSessionEventMetadata{BackgroundTaskSnapshot: &snapshot})}
	panel := DeriveSessionPanel(AgentSession{ID: "sess_1", Provider: "claude", Status: "completed"}, events)
	var order []string
	for _, row := range panel.Background {
		order = append(order, row.Task.ID)
	}
	if want := []string{"run_early", "run_late", "done_new", "done_old"}; !slices.Equal(order, want) {
		t.Fatalf("background = %v; want %v", order, want)
	}
	if panel.Background[0].Owner != "Explorer" || !panel.Busy {
		t.Fatalf("owner %q, busy %v; want Explorer and busy", panel.Background[0].Owner, panel.Busy)
	}
	if codex := DeriveSessionPanel(AgentSession{ID: "sess_1", Provider: "codex"}, events); len(codex.Background) != 0 {
		t.Fatalf("codex background = %+v; only Claude reports background work", codex.Background)
	}
}

func TestPanelTimerRunsAndWakes(t *testing.T) {
	timers := []AgentScheduledTask{{ID: "t1", Kind: "cron", Schedule: "*/30 * * * *", Recurring: true, Prompt: "patrol"}}
	fire := func(id, at, startedAt, completedAt, response string) AgentSessionEvent {
		return panelEvent(id, at, ProcessLabelTimerFire, &AgentSessionEventMetadata{TimerFire: &AgentSessionTimerFire{
			ID: "t1", Origin: "scheduled", Prompt: "patrol", StartedAt: startedAt, CompletedAt: completedAt, Response: response}})
	}
	inputFire := AgentSessionEvent{ID: "evt_in_fire", SessionID: "sess_1", At: "2026-11-03T11:00:00Z", Label: EventLabelUserMessage, Level: "info",
		Message:  &TranscriptMessage{ID: "in_fire", Kind: "user", Text: "patrol"},
		Metadata: &AgentSessionEventMetadata{TimerFire: &AgentSessionTimerFire{ID: "t1", Origin: "scheduled", Prompt: "patrol", StartedAt: "2026-11-03T11:00:00Z"}}}
	events := []AgentSessionEvent{
		panelEvent("evt_timers", "2026-11-03T09:00:00Z", ProcessLabelTimerSync, &AgentSessionEventMetadata{TimerSnapshot: &timers}),
		// Published as it fires and again with its answer.
		fire("evt_fire_1a", "2026-11-03T09:30:00Z", "2026-11-03T09:30:00Z", "", ""),
		fire("evt_fire_1b", "2026-11-03T09:31:00Z", "2026-11-03T09:30:00Z", "2026-11-03T09:31:00Z", "all good"),
		// Its device sent this one as an input; an earlier turn's answer is
		// in the transcript.
		inputFire,
		panelEvent("evt_turn", "2026-11-03T11:02:00Z", EventLabelClaudeTurnEnd, &AgentSessionEventMetadata{TurnUsage: &AgentTurnUsage{DurationMs: 1000}}),
		{ID: "evt_in_2", SessionID: "sess_1", At: "2026-11-03T12:00:00Z", Label: EventLabelUserMessage, Level: "info"},
		// A run that never ended, then a process start that ends it.
		fire("evt_fire_open", "2026-11-03T12:30:00Z", "2026-11-03T12:30:00Z", "", ""),
	}
	session := AgentSession{ID: "sess_1", Provider: "claude", Status: "completed", Input: SessionInput{ID: "in_2"},
		Scheduled: &AgentSessionSchedule{Timers: []AgentSessionScheduledTimer{{ID: "t1", FirstSeenAt: "2026-11-03T09:00:00Z"}}}}

	panel := DeriveSessionPanel(session, events)
	if len(panel.Timers) != 1 || panel.TimerSnapshotAt != "2026-11-03T09:00:00Z" {
		t.Fatalf("timers = %+v at %q", panel.Timers, panel.TimerSnapshotAt)
	}
	timer := panel.Timers[0]
	if timer.Running == nil || timer.Running.StartedAt != "2026-11-03T12:30:00Z" || !panel.Busy {
		t.Fatalf("running = %+v, busy %v; want the open run", timer.Running, panel.Busy)
	}
	var runs []string
	for _, run := range timer.Runs {
		runs = append(runs, run.StartedAt+"/"+run.Response)
	}
	if want := []string{"2026-11-03T12:30:00Z/", "2026-11-03T11:00:00Z/", "2026-11-03T09:30:00Z/all good"}; !slices.Equal(runs, want) {
		t.Fatalf("runs = %v; want %v", runs, want)
	}
	if !timer.Runs[1].AnswerUnloaded || timer.Runs[1].CompletedAt != "2026-11-03T11:02:00Z" {
		t.Fatalf("input run = %+v; want its turn's end and its answer in the transcript", timer.Runs[1])
	}
	if want := []AgentSessionPanelTimerWake{{ID: "t1", FiredAt: "2026-11-03T12:30:00Z"}}; !slices.Equal(panel.TimerWakes, want) {
		t.Fatalf("wakes = %+v; want %+v", panel.TimerWakes, want)
	}

	// A process that starts later ends the open run and wakes the timer.
	resumed := append(slices.Clone(events), AgentSessionEvent{ID: "evt_process", SessionID: "sess_1", At: "2026-11-03T13:00:00Z", Label: EventLabelClaudeProcessStarted, Level: "info"})
	panel = DeriveSessionPanel(session, resumed)
	if panel.Timers[0].Running != nil || panel.Busy {
		t.Fatalf("after a process start: running %+v, busy %v", panel.Timers[0].Running, panel.Busy)
	}
	if want := []AgentSessionPanelTimerWake{{ID: "t1", FiredAt: "2026-11-03T13:00:00Z"}}; !slices.Equal(panel.TimerWakes, want) {
		t.Fatalf("wakes = %+v; want the resume", panel.TimerWakes)
	}

	// The latest input's run is answered by the session's own answer, and
	// a failed one is the failed run the chat's note names.
	latest := session
	latest.Input = SessionInput{ID: "in_fire"}
	latest.Status, latest.Response, latest.CompletedAt = "failed", "prompt is too long", "2026-11-03T11:03:00Z"
	panel = DeriveSessionPanel(latest, events[:4])
	run := panel.Timers[0].Runs[0]
	if run.Response != "prompt is too long" || run.AnswerUnloaded || !run.Failed || run.CompletedAt != "2026-11-03T11:03:00Z" {
		t.Fatalf("latest input run = %+v", run)
	}
	if panel.FailedTimerRun == nil || panel.FailedTimerRun.StartedAt != "2026-11-03T11:00:00Z" {
		t.Fatalf("failed run = %+v", panel.FailedTimerRun)
	}
}

func TestPanelFilesMergeTheirTurns(t *testing.T) {
	added := func(value int) *int { return &value }
	record := func(id, input, op, origin string, add, remove, totalAdd, totalRemove int, diff string) AgentSessionEvent {
		return panelEvent(id, "2026-11-03T10:00:00Z", ProcessLabelRecordedFile, &AgentSessionEventMetadata{SessionFile: &SessionFileRecord{
			Path: "/repo/a.ts", WorkspacePath: "a.ts", Origin: origin, Op: op, InGitRepo: true, InputID: input,
			Added: added(add), Removed: added(remove), TotalAdded: added(totalAdd), TotalRemoved: added(totalRemove), Diff: diff, TotalDiff: diff}})
	}
	panel := DeriveSessionPanel(AgentSession{ID: "sess_1"}, []AgentSessionEvent{
		record("evt_1", "in_1", "created", "tool", 10, 0, 10, 0, "text"),
		record("evt_2", "in_2", "modified", "tool", 2, 1, 12, 1, "text"),
		record("evt_3", "in_3", "referenced", "reference", 0, 0, 12, 1, ""),
	})
	if len(panel.Files) != 1 {
		t.Fatalf("files = %+v", panel.Files)
	}
	file := panel.Files[0]
	if file.Op != "created" || file.Origin != "tool" || !slices.Equal(file.TurnIDs, []string{"in_1", "in_2", "in_3"}) ||
		*file.LineChanges != (AgentSessionPanelLineChanges{Added: 12, Removed: 1}) || file.TurnLineChanges["in_2"] != (AgentSessionPanelLineChanges{Added: 2, Removed: 1}) ||
		file.Diff != "text" || file.TurnDiff["in_1"] != "text" {
		t.Fatalf("file = %+v", file)
	}
}

func TestPanelUsageReadsTheNewestReports(t *testing.T) {
	context := func(id string, input, window int64, model string, compaction bool) AgentSessionEvent {
		usage := &AgentContextUsage{Model: model, ConfiguredWindow: &ConfiguredContextWindow{Tokens: 1000000, Source: "default"}}
		if input != 0 {
			usage.InputTokens = int64p(input)
		}
		if window != 0 {
			usage.ContextWindow = int64p(window)
		}
		if compaction {
			usage.Compaction = &AgentContextCompaction{Trigger: "auto"}
		}
		return panelEvent(id, "2026-11-03T10:00:00Z", ProcessLabelModelRequestUsage, &AgentSessionEventMetadata{ContextUsage: usage})
	}
	cost := 0.5
	turn := func(id string, duration int64) AgentSessionEvent {
		return panelEvent(id, "2026-11-03T10:00:00Z", EventLabelClaudeTurnEnd, &AgentSessionEventMetadata{TurnUsage: &AgentTurnUsage{
			DurationMs: duration, InputTokens: 1, CacheReadTokens: 2, CacheWriteTokens: 3, OutputTokens: 4, CostUSD: &cost}})
	}
	usage := DeriveSessionPanel(AgentSession{ID: "sess_1"}, []AgentSessionEvent{
		context("evt_window", 100, 200000, "opus", false),
		turn("evt_turn_1", 10),
		context("evt_compact", 0, 0, "", true),
		context("evt_newest", 300, 0, "opus", false),
		turn("evt_turn_2", 20),
	}).Usage
	if *usage.UsedTokens != 300 || *usage.ContextWindow != 200000 || usage.Model != "opus" || usage.Turns != 2 ||
		usage.Totals.OutputTokens != 8 || *usage.Totals.CostUSD != 1 || usage.Totals.CostTurns != 2 || *usage.LastTurnDurationMs != 20 ||
		usage.Compactions != 1 || usage.LastCompaction.MessageID != "evt_compact:compaction" {
		t.Fatalf("usage = %+v", usage)
	}
	// Another model's window is not this one's: the window Foundry set
	// stands in. Without context reports, the newest request's input counts.
	other := DeriveSessionPanel(AgentSession{ID: "sess_1"}, []AgentSessionEvent{context("evt_window", 100, 200000, "opus", false), context("evt_newest", 300, 0, "sonnet", false)}).Usage
	if *other.ContextWindow != 1000000 {
		t.Fatalf("window = %d; want the configured one", *other.ContextWindow)
	}
	requests := DeriveSessionPanel(AgentSession{ID: "sess_1"}, []AgentSessionEvent{panelEvent("evt_request", "2026-11-03T10:00:00Z", ProcessLabelModelRequestUsage,
		&AgentSessionEventMetadata{RequestUsage: &ModelRequestUsage{RequestID: "req", InputTokens: 42}})}).Usage
	if requests.UsedTokens == nil || *requests.UsedTokens != 42 || requests.ContextWindow != nil {
		t.Fatalf("request usage = %+v", requests)
	}
}

func TestPanelPreviewsSourcesAndScreen(t *testing.T) {
	frame := &SessionToolFrame{ID: "frame_2", Source: "browser"}
	session := AgentSession{ID: "sess_1", Provider: "claude", Response: "Open http://localhost:5173/app, or http://localhost:3000."}
	panel := DeriveSessionPanel(session, []AgentSessionEvent{
		{ID: "evt_loaded", At: "2026-11-03T10:00:00Z", Label: ProcessLabelLoadedWorkspace, Detail: " /repo ", Level: "info"},
		{ID: "evt_run_1", At: "2026-11-03T10:01:00Z", Label: EventLabelCodexTurnEnd, Level: "info", Detail: "Serving at http://localhost:5173/app."},
		panelEvent("evt_frame_1", "2026-11-03T10:01:30Z", ProcessLabelUsedTool, &AgentSessionEventMetadata{ToolFrame: &SessionToolFrame{ID: "frame_1"}}),
		panelEvent("evt_frame_2", "2026-11-03T10:01:40Z", ProcessLabelUsedTool, &AgentSessionEventMetadata{ToolFrame: frame}),
		{ID: "evt_run_2", At: "2026-11-03T10:02:00Z", Label: EventLabelClaudeTurnEnd, Level: "info", Detail: "Now at http://127.0.0.1:8080"},
	})
	want := []AgentSessionPanelLink{{ID: "evt_run_2", Target: "http://127.0.0.1:8080"}, {ID: "evt_run_1", Target: "http://localhost:5173/app"}, {ID: "sess_1_web_1", Target: "http://localhost:3000"}}
	if !slices.Equal(panel.Previews, want) {
		t.Fatalf("previews = %+v; want %+v", panel.Previews, want)
	}
	if want := []AgentSessionPanelLink{{ID: "evt_loaded", Target: "/repo"}}; !slices.Equal(panel.Sources, want) {
		t.Fatalf("sources = %+v", panel.Sources)
	}
	if panel.Screen != frame || !panel.Focus {
		t.Fatalf("screen = %+v, focus %v", panel.Screen, panel.Focus)
	}
}

func TestPanelEdgeRules(t *testing.T) {
	at := func(minute int) string { return "2026-11-03T10:0" + string(rune('0'+minute)) + ":00Z" }
	timers := func(ids ...string) *AgentSessionEventMetadata {
		tasks := []AgentScheduledTask{}
		for _, id := range ids {
			tasks = append(tasks, AgentScheduledTask{ID: id, Recurring: true})
		}
		return &AgentSessionEventMetadata{TimerSnapshot: &tasks}
	}
	fire := func(id string, minute int, level string) AgentSessionEvent {
		event := panelEvent(id, at(minute), ProcessLabelTimerFire, &AgentSessionEventMetadata{TimerFire: &AgentSessionTimerFire{ID: "t1", Origin: "scheduled", StartedAt: at(minute), CompletedAt: at(minute)}})
		event.Level = level
		return event
	}
	start := AgentSessionEvent{ID: "evt_start", At: at(0), Label: ProcessLabelStartingSubtask, Metadata: &AgentSessionEventMetadata{TaskID: "a", TaskType: SubagentTaskType}}
	held := &AgentSessionSchedule{Timers: []AgentSessionScheduledTimer{{ID: "t1", FirstSeenAt: at(2)}}}

	t.Run("a subagent of a completed session still runs", func(t *testing.T) {
		if panel := DeriveSessionPanel(AgentSession{Status: "completed"}, []AgentSessionEvent{start}); panel.Subagents[0].Status != "running" || panel.Busy {
			t.Fatalf("subagents %+v, busy %v", panel.Subagents, panel.Busy)
		}
		if !DeriveSessionPanel(AgentSession{Status: "blocked"}, nil).Busy {
			t.Fatal("a live session is busy")
		}
	})
	t.Run("only local addresses a run named are previews", func(t *testing.T) {
		panel := DeriveSessionPanel(AgentSession{ID: "s", Response: "See https://example.com"}, []AgentSessionEvent{
			{ID: "evt_path", At: at(0), Label: EventLabelClaudeTurnEnd, Level: "info", Detail: "/tmp/run/result.md"},
			{ID: "evt_profile", At: at(1), Label: EventLabelProfileCommandTurnEnd, Level: "info", Detail: "http://localhost:8000"},
		})
		if want := []AgentSessionPanelLink{{ID: "evt_profile", Target: "http://localhost:8000"}}; !slices.Equal(panel.Previews, want) {
			t.Fatalf("previews = %+v", panel.Previews)
		}
	})
	t.Run("an empty snapshot clears the timers; a later good run the failure", func(t *testing.T) {
		panel := DeriveSessionPanel(AgentSession{Scheduled: held}, []AgentSessionEvent{
			panelEvent("evt_timers", at(0), ProcessLabelTimerSync, timers("t1")), fire("evt_failed", 1, "error"), fire("evt_ok", 3, "info"),
			panelEvent("evt_cleared", at(4), ProcessLabelTimerSync, timers()),
		})
		if len(panel.Timers) != 0 || panel.FailedTimerRun != nil {
			t.Fatalf("timers %+v, failed run %+v", panel.Timers, panel.FailedTimerRun)
		}
	})
	t.Run("a process started before the timer existed did not wake it", func(t *testing.T) {
		panel := DeriveSessionPanel(AgentSession{Scheduled: held}, []AgentSessionEvent{
			{ID: "evt_process", At: at(1), Label: EventLabelClaudeProcessStarted, Level: "info"},
			panelEvent("evt_timers", at(2), ProcessLabelTimerSync, timers("t1")),
		})
		if len(panel.TimerWakes) != 0 {
			t.Fatalf("wakes = %+v", panel.TimerWakes)
		}
	})
	t.Run("an input's run in progress is answering, not running", func(t *testing.T) {
		input := AgentSessionEvent{ID: "evt_input", At: at(1), Label: EventLabelUserMessage, Level: "info", Message: &TranscriptMessage{ID: "in_1"},
			Metadata: &AgentSessionEventMetadata{TimerFire: &AgentSessionTimerFire{ID: "t1", Origin: "scheduled", StartedAt: at(1)}}}
		panel := DeriveSessionPanel(AgentSession{Status: "running", Input: SessionInput{ID: "in_1"}}, []AgentSessionEvent{panelEvent("evt_timers", at(0), ProcessLabelTimerSync, timers("t1")), input})
		if timer := panel.Timers[0]; timer.Running != nil || timer.Runs[0].CompletedAt != "" {
			t.Fatalf("timer = %+v", timer)
		}
	})
	t.Run("a compaction without its size leaves the context unknown; cost counts the turns that priced", func(t *testing.T) {
		cost := 0.5
		usage := DeriveSessionPanel(AgentSession{}, []AgentSessionEvent{
			panelEvent("evt_context", at(0), ProcessLabelModelRequestUsage, &AgentSessionEventMetadata{ContextUsage: &AgentContextUsage{InputTokens: int64p(10)}}),
			panelEvent("evt_compaction", at(1), ProcessLabelModelRequestUsage, &AgentSessionEventMetadata{ContextUsage: &AgentContextUsage{Compaction: &AgentContextCompaction{Trigger: "auto"}}}),
			panelEvent("evt_turn_1", at(2), EventLabelClaudeTurnEnd, &AgentSessionEventMetadata{TurnUsage: &AgentTurnUsage{CostUSD: &cost}}),
			panelEvent("evt_turn_2", at(3), EventLabelCodexTurnEnd, &AgentSessionEventMetadata{TurnUsage: &AgentTurnUsage{}}),
		}).Usage
		if usage.UsedTokens != nil || usage.Turns != 2 || usage.Totals.CostTurns != 1 || *usage.Totals.CostUSD != cost {
			t.Fatalf("usage = %+v", usage)
		}
	})
}
