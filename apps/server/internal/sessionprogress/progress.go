// Package sessionprogress derives progress facts from a session's stored
// event log: what it did last, the step its plan is on, its recent tool
// calls, and deterministic detector flags. Everything here is a pure
// function of the log; nothing reads a device or writes to a session, so an
// orchestrator pulls these facts only when it needs them.
package sessionprogress

import (
	"cmp"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

const (
	// RepeatedFailureThreshold is how often one tool call must fail in the
	// current turn before the fact is reported.
	RepeatedFailureThreshold = 3
	// RateLimitThreshold and RateLimitWindow describe a rate-limit storm.
	RateLimitThreshold = 5
	RateLimitWindow    = 10 * time.Minute
	// QuietAfter is how long a running session may go without an event that
	// is not a known wait before the fact is reported.
	QuietAfter = 25 * time.Minute

	toolDetailLimit = 160
	toolNameLimit   = 80
)

// ToolCall is one tool call the log recorded, paired from its start and its
// end when both are present.
type ToolCall struct {
	Tool       string `json:"tool"`
	Detail     string `json:"detail,omitempty"`
	Status     string `json:"status"`
	StartedAt  string `json:"startedAt,omitempty"`
	DurationMs *int64 `json:"durationMs,omitempty"`
}

// Flags are the detector facts. An empty value means the condition was not
// detected; each non-empty value is one short line an orchestrator can read
// without any further query.
type Flags struct {
	RepeatedFailure string `json:"repeatedFailure,omitempty"`
	RateLimitStorm  string `json:"rateLimitStorm,omitempty"`
	Quiet           string `json:"quiet,omitempty"`
}

// Empty reports whether no detector found anything.
func (flags Flags) Empty() bool {
	return flags == Flags{}
}

// Detect runs the event-log detectors over the session's event log.
func Detect(events []store.AgentSessionEvent, status string, now time.Time) Flags {
	return Flags{
		RepeatedFailure: RepeatedFailure(events),
		RateLimitStorm:  RateLimitStorm(events),
		Quiet:           Quiet(status, events, now),
	}
}

// LastEvent is the newest event an agent sees: a token report or a tool
// frame is a viewer detail, not what the session did.
func LastEvent(events []store.AgentSessionEvent) (at, label string) {
	for index := len(events) - 1; index >= 0; index-- {
		if visible(events[index]) && strings.TrimSpace(events[index].Label) != "" {
			return events[index].At, events[index].Label
		}
	}
	return "", ""
}

// WaitLabels are events that say the session is waiting on something outside
// its own work; they do not count as activity when judging silence.
var WaitLabels = map[string]bool{
	store.ProcessLabelWaitingBackgroundTasks: true,
	store.ProcessLabelWaitingForSlot:         true,
	store.ProcessLabelWaitedForSlot:          true,
}

// LastActivity is the newest event that is not a known wait.
func LastActivity(events []store.AgentSessionEvent) (at, label string) {
	for index := len(events) - 1; index >= 0; index-- {
		event := events[index]
		if !visible(event) || WaitLabels[event.Label] {
			continue
		}
		if strings.TrimSpace(event.Label) != "" {
			return event.At, event.Label
		}
	}
	return "", ""
}

// PlanStep is the first unchecked item of the newest plan the runtime
// reported; empty when it reported none or every step is done.
func PlanStep(events []store.AgentSessionEvent) string {
	for index := len(events) - 1; index >= 0; index-- {
		event := events[index]
		if event.Label != store.ProcessLabelUpdatedPlan {
			continue
		}
		for _, line := range strings.Split(event.Detail, "\n") {
			trimmed := strings.TrimSpace(line)
			if !strings.HasPrefix(trimmed, "- [ ] ") && !strings.HasPrefix(trimmed, "* [ ] ") {
				continue
			}
			step := strings.TrimSpace(strings.TrimPrefix(strings.TrimLeft(trimmed, "-* "), "[ ]"))
			if step != "" {
				return textcut.Excerpt(step, 200)
			}
		}
		return ""
	}
	return ""
}

// ToolCalls pairs the tool calls in the log: the tool's name, a short
// detail, whether it completed or failed, and how long it ran.
func ToolCalls(events []store.AgentSessionEvent) []ToolCall {
	var calls []ToolCall
	byID := map[string]int{}
	byTool := map[string][]int{}
	pending := func(index int) {
		call := calls[index]
		if call.Tool != "" {
			byTool[call.Tool] = append(byTool[call.Tool], index)
		}
	}
	unpend := func(tool string, index int) {
		queue := byTool[tool]
		for at, candidate := range queue {
			if candidate == index {
				byTool[tool] = append(queue[:at], queue[at+1:]...)
				return
			}
		}
	}
	take := func(id, tool string) int {
		if id != "" {
			if index, ok := byID[id]; ok {
				delete(byID, id)
				unpend(calls[index].Tool, index)
				return index
			}
		}
		if queue := byTool[tool]; len(queue) > 0 {
			index := queue[0]
			byTool[tool] = queue[1:]
			for key, at := range byID {
				if at == index {
					delete(byID, key)
				}
			}
			return index
		}
		return -1
	}
	for _, event := range events {
		if !visible(event) {
			continue
		}
		tool := ToolName(event.Detail)
		_, starts := callStarts[event.Label]
		failed, ends := callEnds[event.Label]
		switch {
		case starts:
			id := callID(event)
			if _, ok := byID[id]; ok && id != "" {
				// A progress update of the same call.
				continue
			}
			if id == "" && len(byTool[tool]) > 0 {
				// A repeated progress frame carries no id.
				continue
			}
			calls = append(calls, ToolCall{
				Tool: tool, Detail: ShortDetail(event.Detail), Status: "running", StartedAt: event.At,
			})
			if id != "" {
				byID[id] = len(calls) - 1
			}
			pending(len(calls) - 1)
		case ends:
			id := callID(event)
			index := take(id, tool)
			status := "completed"
			if failed != nil && failed(event) {
				status = "failed"
			}
			if index < 0 {
				calls = append(calls, ToolCall{
					Tool: tool, Detail: ShortDetail(event.Detail), Status: status, StartedAt: event.At,
				})
				continue
			}
			calls[index].Status = status
			if calls[index].Detail == "" {
				calls[index].Detail = ShortDetail(event.Detail)
			}
			if started, ok := parseTime(calls[index].StartedAt); ok {
				if ended, ok := parseTime(event.At); ok && !ended.Before(started) {
					duration := ended.Sub(started).Milliseconds()
					calls[index].DurationMs = &duration
				}
			}
		}
	}
	return calls
}

// RepeatedFailure reports the first tool call of the current turn that
// failed at least RepeatedFailureThreshold times with the same normalised
// detail.
func RepeatedFailure(events []store.AgentSessionEvent) string {
	type failure struct {
		tool, detail string
		count        int
	}
	var order []string
	failures := map[string]*failure{}
	for _, event := range events[turnStart(events):] {
		if event.Label != store.ProcessLabelToolFailed {
			continue
		}
		tool := ToolName(event.Detail)
		key := tool + "\x00" + NormaliseDetail(event.Detail)
		item := failures[key]
		if item == nil {
			item = &failure{tool: tool, detail: ShortDetail(event.Detail)}
			failures[key] = item
			order = append(order, key)
		}
		item.count++
	}
	for _, key := range order {
		if item := failures[key]; item.count >= RepeatedFailureThreshold {
			detail := item.tool
			if item.detail != "" {
				detail += ": " + item.detail
			}
			return fmt.Sprintf("%s failed %d times with the same call in the current turn", detail, item.count)
		}
	}
	return ""
}

// RateLimitStorm reports RateLimitThreshold or more rate-limit waits inside
// RateLimitWindow.
func RateLimitStorm(events []store.AgentSessionEvent) string {
	var times []time.Time
	for _, event := range events {
		if event.Label != store.ProcessLabelRateLimited {
			continue
		}
		if at, ok := parseTime(event.At); ok {
			times = append(times, at)
		}
	}
	sort.Slice(times, func(left, right int) bool { return times[left].Before(times[right]) })
	for start := 0; start < len(times); start++ {
		end := start
		for end < len(times) && times[end].Sub(times[start]) <= RateLimitWindow {
			end++
		}
		if end-start >= RateLimitThreshold {
			return fmt.Sprintf("%d rate-limit waits within %s (last at %s)",
				end-start, (times[end-1].Sub(times[start])).Round(time.Second).String(), times[end-1].UTC().Format(time.RFC3339))
		}
	}
	return ""
}

// Quiet reports a running session whose last real activity is older than
// QuietAfter. Known waits (background tasks, execution slots) are not
// activity, so they do not hide a silence.
func Quiet(status string, events []store.AgentSessionEvent, now time.Time) string {
	if status != "running" {
		return ""
	}
	at, label := LastActivity(events)
	when, ok := parseTime(at)
	if !ok {
		return ""
	}
	silence := now.Sub(when)
	if silence <= QuietAfter {
		return ""
	}
	return fmt.Sprintf("no activity for %s (last: %s at %s)",
		silence.Round(time.Minute).String(), label, when.UTC().Format(time.RFC3339))
}

// ToolName is the tool a call detail starts with.
func ToolName(detail string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(detail), "\n")
	line = strings.TrimSpace(line)
	if line == "" {
		return "tool"
	}
	return textcut.Excerpt(line, toolNameLimit)
}

// ShortDetail is the call's detail without the tool name or code fence,
// folded to one short line.
func ShortDetail(detail string) string {
	_, rest, found := strings.Cut(detail, "\n")
	if !found {
		return ""
	}
	var lines []string
	for _, line := range strings.Split(rest, "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case trimmed == "", strings.HasPrefix(trimmed, "```"), trimmed == "Arguments", trimmed == "Result", trimmed == "Error":
			continue
		}
		lines = append(lines, trimmed)
	}
	return textcut.Excerpt(strings.Join(strings.Fields(strings.Join(lines, " ")), " "), toolDetailLimit)
}

// NormaliseDetail folds whitespace so the same call compares equal.
func NormaliseDetail(detail string) string {
	return strings.Join(strings.Fields(detail), " ")
}

// callStartLabels mark a tool call beginning; callEnds maps a completion
// label to what makes it a failure (nil: it never is). Claude reports tools
// by call id (Using tool/Used tool/Tool failed); Codex reports commands,
// searches and edits with their own labelled pairs.
var callStarts = map[string]bool{
	store.ProcessLabelUsingTool:      true,
	store.ProcessLabelRunningCommand: true,
	store.ProcessLabelSearching:      true,
	store.ProcessLabelEditingFile:    true,
}

var callEnds = map[string]func(store.AgentSessionEvent) bool{
	store.ProcessLabelUsedTool:   nil,
	store.ProcessLabelToolFailed: func(store.AgentSessionEvent) bool { return true },
	store.ProcessLabelRanCommand: func(event store.AgentSessionEvent) bool { return event.Level == "error" },
	store.ProcessLabelSearched:   nil,
	store.ProcessLabelEditedFile: func(event store.AgentSessionEvent) bool { return event.Level == "error" },
}

func callID(event store.AgentSessionEvent) string {
	if event.Message != nil && event.Message.Kind == "tool" {
		return cmp.Or(event.Message.CallID, event.Message.ID)
	}
	if event.Metadata != nil {
		return event.Metadata.ToolUseID
	}
	return ""
}

// turnStart is where the current turn begins: the newest input that started
// one, or the event after the newest turn end.
func turnStart(events []store.AgentSessionEvent) int {
	for index := len(events) - 1; index >= 0; index-- {
		switch events[index].Label {
		case store.EventLabelUserMessage, store.ProcessLabelBackgroundTurn, store.ProcessLabelTimerFire:
			return index
		}
		if store.IsTurnEndLabel(events[index].Label) {
			return index + 1
		}
	}
	return 0
}

func visible(event store.AgentSessionEvent) bool {
	return event.Metadata == nil || (event.Metadata.RequestUsage == nil && event.Metadata.ToolFrame == nil)
}

func parseTime(value string) (time.Time, bool) {
	at, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	return at, err == nil
}
