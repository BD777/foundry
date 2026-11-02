package sqlitestore

import (
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// planned runs planTurnCompaction on a turn of the given events (an input
// first, then one a microsecond apart) and returns the ids it removes and
// the turn as left.
func planned(t *testing.T, events ...store.AgentSessionEvent) ([]string, []*compactionRow) {
	t.Helper()
	base := time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC)
	input := store.AgentSessionEvent{ID: "evt_input", Label: store.EventLabelUserMessage, Level: "info",
		Message: &store.TranscriptMessage{ID: "input", Kind: "user", Text: "go"}}
	turn := []*compactionRow{}
	for index, event := range append([]store.AgentSessionEvent{input}, events...) {
		if event.At == "" {
			event.At = formatTime(base.Add(time.Duration(index) * time.Microsecond))
		}
		if event.Level == "" {
			event.Level = "info"
		}
		turn = append(turn, &compactionRow{rowID: int64(index + 1), event: event})
	}
	planTurnCompaction(turn)
	var removed []string
	for _, row := range turn {
		if row.removed {
			removed = append(removed, row.event.ID)
		}
	}
	return removed, turn
}

func step(id, label, messageID, kind, callID, status, text string) store.AgentSessionEvent {
	return store.AgentSessionEvent{ID: id, Label: label, Detail: text,
		Message: &store.TranscriptMessage{ID: messageID, Kind: kind, CallID: callID, Status: status, Text: text}}
}

func withUsage(event store.AgentSessionEvent, id string, input, output int64) store.AgentSessionEvent {
	message := *event.Message
	message.RequestUsage = &store.ModelRequestUsage{RequestID: id, InputTokens: input, OutputTokens: output}
	event.Message = &message
	return event
}

func usageReport(id, request string, input, output int64) store.AgentSessionEvent {
	return store.AgentSessionEvent{ID: id, Label: "Model request usage",
		Metadata: &store.AgentSessionEventMetadata{RequestUsage: &store.ModelRequestUsage{RequestID: request, InputTokens: input, OutputTokens: output}}}
}

func contextUsage(id string, input, window int64, compaction bool) store.AgentSessionEvent {
	usage := &store.AgentContextUsage{}
	if input != 0 {
		usage.InputTokens = &input
	}
	if window != 0 {
		usage.ContextWindow = &window
	}
	if compaction {
		usage.Compaction = &store.AgentContextCompaction{Trigger: "auto"}
	}
	return store.AgentSessionEvent{ID: id, Label: "Model request usage", Metadata: &store.AgentSessionEventMetadata{ContextUsage: usage}}
}

func rowByID(turn []*compactionRow, id string) *compactionRow {
	for _, row := range turn {
		if row.event.ID == id {
			return row
		}
	}
	return nil
}

func TestPlanRemovesSnapshotsThatShowInPlace(t *testing.T) {
	removed, turn := planned(t,
		step("think_1", "Thinking", "think", "reasoning", "", "running", "Let"),
		step("think_2", "Thought", "think", "reasoning", "", "completed", "Let me."),
		withUsage(step("tool_1", "Using tool", "tool", "tool", "call_1", "running", "Bash"), "req_1", 10, 1),
		usageReport("usage_1", "req_1", 12, 30),
		step("tool_2", "Used tool", "tool", "tool", "call_1", "completed", "Bash\n\nok"),
		step("note_1", "Commentary", "note", "commentary", "", "", "Al"),
		step("note_2", "Commentary", "note", "commentary", "", "", "All good."),
		usageReport("usage_2", "req_2", 1, 1),
	)
	if want := []string{"think_1", "tool_1", "usage_1", "note_1"}; !slices.Equal(removed, want) {
		t.Fatalf("removed %v; want %v", removed, want)
	}
	// The finished step carries the request's tokens, the larger of each.
	if usage := rowByID(turn, "tool_2").event.Message.RequestUsage; usage == nil || *usage != (store.ModelRequestUsage{RequestID: "req_1", InputTokens: 12, OutputTokens: 30}) {
		t.Fatalf("tool_2 usage = %+v", usage)
	}
}

func TestPlanKeepsSnapshotsTheWebShowsApart(t *testing.T) {
	for _, test := range []struct {
		name   string
		events []store.AgentSessionEvent
	}{
		{"a message between", []store.AgentSessionEvent{
			step("cmd_1", "Running command", "cmd", "tool", "call_2", "running", "make"),
			step("steer", "Steered into active turn", "steer", "user", "", "", "also lint"),
			step("cmd_2", "Ran command", "cmd", "tool", "call_2", "completed", "make\n\nok"),
		}},
		{"another step between", []store.AgentSessionEvent{
			step("cmd_1", "Running command", "cmd", "tool", "call_2", "running", "make"),
			step("other", "Ran command", "other", "tool", "call_3", "completed", "ls"),
			step("cmd_2", "Ran command", "cmd", "tool", "call_2", "completed", "make\n\nok"),
		}},
		{"a screenshot between", []store.AgentSessionEvent{
			step("cmd_1", "Using tool", "cmd", "tool", "call_2", "running", "browser"),
			{ID: "frame", Label: "Tool frame", Metadata: &store.AgentSessionEventMetadata{ToolFrame: &store.SessionToolFrame{ID: "f1", CallID: "call_2"}}},
			step("cmd_2", "Used tool", "cmd", "tool", "call_2", "completed", "browser\n\nok"),
		}},
		{"a call another item reports", []store.AgentSessionEvent{
			step("cmd_1", "Using tool", "cmd", "tool", "call_2", "running", "Agent"),
			step("cmd_2", "Used tool", "cmd", "tool", "call_2", "completed", "Agent\n\ndone"),
			step("result", "Used tool", "result", "tool", "call_2", "completed", "result"),
		}},
		{"no call or status to merge by", []store.AgentSessionEvent{
			step("think_1", "Thinking", "think", "reasoning", "", "", "Let"),
			step("think_2", "Thought", "think", "reasoning", "", "", "Let me."),
		}},
		{"a label others read", []store.AgentSessionEvent{
			step("failed_1", "Notice", "failed", "status", "", "running", "x"),
			step("failed_2", "Session failed", "failed", "status", "", "completed", "x y"),
		}},
		{"usage of another request", []store.AgentSessionEvent{
			withUsage(step("tool_1", "Using tool", "tool", "tool", "call_1", "running", "Bash"), "req_1", 10, 1),
			withUsage(step("tool_2", "Used tool", "tool", "tool", "call_1", "completed", "Bash\n\nok"), "req_9", 10, 1),
		}},
		{"usage the latest step would take", []store.AgentSessionEvent{
			withUsage(step("tool_1", "Using tool", "tool", "tool", "call_1", "running", "Bash"), "req_1", 10, 1),
			step("tool_2", "Used tool", "tool", "tool", "call_1", "completed", "Bash\n\nok"),
			usageReport("usage_9", "req_9", 3, 3),
			usageReport("usage_newest", "req_8", 3, 3),
		}},
		{"commentary losing a field", []store.AgentSessionEvent{
			{ID: "note_1", Label: "Commentary", Message: &store.TranscriptMessage{ID: "note", Kind: "commentary", Title: "Plan", Text: "A"}},
			step("note_2", "Commentary", "note", "commentary", "", "", "AB"),
		}},
		{"after commentary that ends later", []store.AgentSessionEvent{
			step("note_1", "Commentary", "note", "commentary", "", "", "A"),
			step("think_1", "Thinking", "think", "reasoning", "", "running", "Let"),
			step("think_2", "Thought", "think", "reasoning", "", "completed", "Let me."),
			step("note_2", "Commentary", "note", "commentary", "", "", "AB"),
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			removed, _ := planned(t, test.events...)
			for _, id := range removed {
				if id != "usage_9" {
					t.Fatalf("removed %v; only a usage report the latest step takes may go", removed)
				}
			}
		})
	}
}

func TestPlanKeepsContextReportsTheirReadersTake(t *testing.T) {
	removed, _ := planned(t,
		contextUsage("ctx_first", 100, 0, false),
		contextUsage("ctx_window", 200, 1000, false),
		contextUsage("ctx_plain", 300, 0, false),
		contextUsage("ctx_compaction", 0, 0, true),
		contextUsage("ctx_resolves", 50, 0, false),
		contextUsage("ctx_plain_2", 60, 0, false),
		contextUsage("ctx_newest", 70, 0, false),
	)
	if want := []string{"ctx_plain", "ctx_plain_2"}; !slices.Equal(removed, want) {
		t.Fatalf("removed %v; want %v", removed, want)
	}
}

func TestPlanFoldsUsageOnlyWhereTheWebWouldPutIt(t *testing.T) {
	// A report no step names goes to the latest step when that is a
	// process step without usage; one that an answer names stays.
	removed, turn := planned(t,
		step("tool", "Used tool", "tool", "tool", "call_1", "completed", "Bash"),
		usageReport("usage_fallback", "req_1", 5, 6),
		store.AgentSessionEvent{ID: "answer", Label: "Response stream", Detail: "Done", Message: &store.TranscriptMessage{ID: "answer", Kind: "assistant", Text: "Done",
			RequestUsage: &store.ModelRequestUsage{RequestID: "req_2"}}},
		usageReport("usage_answer", "req_2", 7, 8),
		usageReport("usage_newest", "req_3", 1, 1),
	)
	if want := []string{"usage_fallback"}; !slices.Equal(removed, want) {
		t.Fatalf("removed %v; want %v", removed, want)
	}
	if usage := rowByID(turn, "tool").event.Message.RequestUsage; usage == nil || fmt.Sprint(*usage) != fmt.Sprint(store.ModelRequestUsage{RequestID: "req_1", InputTokens: 5, OutputTokens: 6}) {
		t.Fatalf("tool usage = %+v", usage)
	}
}

// A step that opens its process group sets the group's start, which an
// answer begun before it and finished after it pushes to the step's own
// time: that snapshot stays. Later in the group it goes.
func TestPlanKeepsTheSnapshotThatStartsItsGroup(t *testing.T) {
	answer := func(id, text string) store.AgentSessionEvent {
		return store.AgentSessionEvent{ID: id, Label: "Response stream", Detail: text,
			Message: &store.TranscriptMessage{ID: "answer", Kind: "assistant", Text: text}}
	}
	opening := []store.AgentSessionEvent{
		answer("answer_1", "I'll"),
		step("tool_1", "Using tool", "tool", "tool", "call_1", "running", "Bash"),
		step("tool_2", "Used tool", "tool", "tool", "call_1", "completed", "Bash\n\nok"),
		answer("answer_2", "I'll run it."),
	}
	if removed, _ := planned(t, opening...); len(removed) != 0 {
		t.Fatalf("removed %v; the group's first step stays", removed)
	}
	later := append(append(opening[:1:1], step("think", "Thought", "think", "reasoning", "", "completed", "Hm.")), opening[1:]...)
	if removed, _ := planned(t, later...); !slices.Equal(removed, []string{"tool_1"}) {
		t.Fatalf("removed %v; want the step after the group's first", removed)
	}
}
