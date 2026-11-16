package sessionprogress

import (
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func at(base time.Time, offset time.Duration) string {
	return base.Add(offset).Format(time.RFC3339Nano)
}

func event(at, label, detail string) store.AgentSessionEvent {
	return store.AgentSessionEvent{At: at, Label: label, Detail: detail, Level: "info"}
}

func toolEvent(at, label, detail, id string) store.AgentSessionEvent {
	item := event(at, label, detail)
	item.Message = &store.TranscriptMessage{ID: id, CallID: id, Kind: "tool", Status: "completed"}
	return item
}

func TestToolCallsPairStartsAndEndsWithDurations(t *testing.T) {
	base := time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC)
	bash := "Bash\n\n```json\n{\"command\":\"go test ./...\"}\n```"
	bad := "Bash\n\n```json\n{\"command\":\"curl nope\"}\n```"
	events := []store.AgentSessionEvent{
		event(at(base, 0), store.EventLabelUserMessage, "Run the checks."),
		toolEvent(at(base, time.Second), store.ProcessLabelUsingTool, bash, "t1"),
		// A progress frame repeats the same call and its input.
		toolEvent(at(base, 2*time.Second), store.ProcessLabelUsingTool, bash, "t1"),
		event(at(base, 3*time.Second), store.ProcessLabelUsedTool, bash),
		event(at(base, 4*time.Second), store.ProcessLabelUsingTool, bad),
		event(at(base, 5*time.Second), store.ProcessLabelToolFailed, bad),
		event(at(base, 6*time.Second), store.ProcessLabelRunningCommand, "npm test"),
		func() store.AgentSessionEvent {
			item := event(at(base, 8*time.Second), store.ProcessLabelRanCommand, "npm test\n\n```\nFAIL\n```")
			item.Level = "error"
			return item
		}(),
	}
	calls := ToolCalls(events)
	if len(calls) != 3 {
		t.Fatalf("calls = %+v, want 3", calls)
	}
	if calls[0].Tool != "Bash" || calls[0].Status != "completed" || calls[0].Detail != `{"command":"go test ./..."}` ||
		calls[0].DurationMs == nil || *calls[0].DurationMs != 2000 {
		t.Fatalf("completed call = %+v", calls[0])
	}
	if calls[1].Tool != "Bash" || calls[1].Status != "failed" || calls[1].DurationMs == nil || *calls[1].DurationMs != 1000 {
		t.Fatalf("failed call = %+v", calls[1])
	}
	if calls[2].Tool != "npm test" || calls[2].Status != "failed" || calls[2].Detail != "FAIL" ||
		calls[2].DurationMs == nil || *calls[2].DurationMs != 2000 {
		t.Fatalf("codex command = %+v", calls[2])
	}
	// An unfinished call stays running without a duration.
	running := ToolCalls([]store.AgentSessionEvent{event(at(base, 0), store.ProcessLabelUsingTool, bash)})
	if len(running) != 1 || running[0].Status != "running" || running[0].DurationMs != nil {
		t.Fatalf("running call = %+v", running)
	}
}

func TestRepeatedFailureCountsOnlyTheCurrentTurn(t *testing.T) {
	base := time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC)
	detail := "Bash\n\n```json\n{\"command\":\"make test\"}\n```"
	events := []store.AgentSessionEvent{
		event(at(base, 0), store.EventLabelUserMessage, "first"),
		event(at(base, time.Minute), store.ProcessLabelToolFailed, detail),
		event(at(base, 2*time.Minute), store.ProcessLabelToolFailed, detail),
		event(at(base, 3*time.Minute), store.EventLabelUserMessage, "again"),
		event(at(base, 4*time.Minute), store.ProcessLabelToolFailed, detail),
	}
	if got := RepeatedFailure(events); got != "" {
		t.Fatalf("failure = %q, want none before the third failure of this turn", got)
	}
	events = append(events,
		event(at(base, 5*time.Minute), store.ProcessLabelToolFailed, detail),
		event(at(base, 6*time.Minute), store.ProcessLabelToolFailed, "  Bash\n\n```json\n{\"command\":\"make   test\"}\n```  "),
	)
	got := RepeatedFailure(events)
	if !strings.Contains(got, "Bash") || !strings.Contains(got, "3 times") {
		t.Fatalf("failure = %q", got)
	}
	// Different calls do not add up.
	var different []store.AgentSessionEvent
	for index := 0; index < RepeatedFailureThreshold; index++ {
		different = append(different, event(at(base, time.Duration(index)*time.Minute), store.ProcessLabelToolFailed,
			"Bash\n\n```json\n{\"command\":\"step "+string(rune('a'+index))+"\"}\n```"))
	}
	if got := RepeatedFailure(different); got != "" {
		t.Fatalf("different failures = %q", got)
	}
}

func TestRateLimitStormNeedsFiveWaitsInsideTenMinutes(t *testing.T) {
	base := time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC)
	var events []store.AgentSessionEvent
	for index := 0; index < 4; index++ {
		events = append(events, event(at(base, time.Duration(index)*time.Minute), store.ProcessLabelRateLimited, "HTTP 429"))
	}
	if got := RateLimitStorm(events); got != "" {
		t.Fatalf("four waits = %q", got)
	}
	events = append(events, event(at(base, 4*time.Minute), store.ProcessLabelRateLimited, "HTTP 429"))
	if got := RateLimitStorm(events); !strings.Contains(got, "5 rate-limit waits") {
		t.Fatalf("five waits = %q", got)
	}
	var spread []store.AgentSessionEvent
	for index := 0; index < 5; index++ {
		spread = append(spread, event(at(base, time.Duration(index)*3*time.Minute), store.ProcessLabelRateLimited, "HTTP 429"))
	}
	if got := RateLimitStorm(spread); got != "" {
		t.Fatalf("spread waits = %q", got)
	}
}

func TestQuietExcludesKnownWaits(t *testing.T) {
	now := time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC)
	events := []store.AgentSessionEvent{
		event(at(now, -30*time.Minute), store.ProcessLabelUsingTool, "Bash"),
		event(at(now, -time.Minute), store.ProcessLabelWaitingBackgroundTasks, "one task is open"),
	}
	got := Quiet("running", events, now)
	if !strings.Contains(got, "no activity for 30m0s") || !strings.Contains(got, "Using tool") {
		t.Fatalf("quiet = %q", got)
	}
	if got := Quiet("completed", events, now); got != "" {
		t.Fatalf("completed session = %q", got)
	}
	recent := append(events, event(at(now, -10*time.Minute), store.ProcessLabelThinking, "working"))
	if got := Quiet("running", recent, now); got != "" {
		t.Fatalf("recent activity = %q", got)
	}
	if got := Quiet("running", []store.AgentSessionEvent{event(at(now, -time.Minute), store.ProcessLabelWaitingForSlot, "queued")}, now); got != "" {
		t.Fatalf("nothing but a wait = %q", got)
	}
}

func TestBudgetReportsTheEightyAndNinetyFiveMarks(t *testing.T) {
	for _, tc := range []struct {
		tokens int64
		want   string
	}{
		{79, ""},
		{80, "tokens 80% of 100 (80% mark)"},
		{96, "tokens 96% of 100 (95% mark)"},
	} {
		if got := Budget(tc.tokens, 100, 0, 0); got != tc.want {
			t.Errorf("Budget(%d) = %q, want %q", tc.tokens, got, tc.want)
		}
	}
	if got := Budget(0, 0, 50*time.Minute, 60); !strings.Contains(got, "time 83% of 60 min (80% mark)") {
		t.Fatalf("time budget = %q", got)
	}
	if got := Budget(0, 0, 59*time.Minute, 60); !strings.Contains(got, "95% mark") {
		t.Fatalf("time budget at 98%% = %q", got)
	}
	if got := Budget(90, 100, 30*time.Minute, 60); got != "tokens 90% of 100 (80% mark)" {
		t.Fatalf("both budgets = %q", got)
	}
}

func TestPlanStepIsTheFirstUncheckedItem(t *testing.T) {
	events := []store.AgentSessionEvent{
		event("2026-11-16T10:00:00Z", store.ProcessLabelUpdatedPlan, "- [ ] old step"),
		event("2026-11-16T10:10:00Z", store.ProcessLabelUpdatedPlan, "- [x] scaffold\n- [ ] run the tests\n- [ ] deploy"),
	}
	if got := PlanStep(events); got != "run the tests" {
		t.Fatalf("plan step = %q", got)
	}
	if got := PlanStep([]store.AgentSessionEvent{event("2026-11-16T10:00:00Z", store.ProcessLabelUpdatedPlan, "- [x] all done")}); got != "" {
		t.Fatalf("finished plan = %q", got)
	}
	if got := PlanStep(nil); got != "" {
		t.Fatalf("no plan = %q", got)
	}
}

func TestUsageSinceAndLastEventSkipHiddenReports(t *testing.T) {
	since := time.Date(2026, 11, 16, 10, 5, 0, 0, time.UTC)
	usage := func(at string, input, output int64) store.AgentSessionEvent {
		item := event(at, store.ProcessLabelModelRequestUsage, "msg")
		item.Metadata = &store.AgentSessionEventMetadata{RequestUsage: &store.ModelRequestUsage{InputTokens: input, OutputTokens: output}}
		return item
	}
	events := []store.AgentSessionEvent{
		usage("2026-11-16T10:00:00Z", 1000, 500),
		usage("2026-11-16T10:06:00Z", 2000, 200),
		event("2026-11-16T10:07:00Z", store.ProcessLabelUsingTool, "Bash"),
	}
	if got := UsageSince(events, since); got != 2200 {
		t.Fatalf("usage = %d, want 2200", got)
	}
	if at, label := LastEvent(events); at != "2026-11-16T10:07:00Z" || label != store.ProcessLabelUsingTool {
		t.Fatalf("last event = %q %q", at, label)
	}
	if got := ShortDetail("Bash\n\n```json\n{\"command\": \"ls\"}\n```"); got != `{"command": "ls"}` {
		t.Fatalf("short detail = %q", got)
	}
}
