package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessionprogress"
)

// Progress facts an orchestrator pulls instead of pushing anything into a
// worker: what the session last did, the step its plan is on, the question it
// waits on, and deterministic flags computed from the event log. They are
// small and read on demand; nothing here reaches the worker.

const (
	progressDefaultCalls  = 10
	progressMaxCalls      = 50
	progressErrorLimit    = 200
	progressQuestionLimit = 300
	// progressListWindow is how many recent events one list row reads: enough
	// for the detectors without loading a long transcript.
	progressListWindow = 200
)

// sessionProgress is the compact progress object on get_session and
// read_context scope=progress.
type sessionProgress struct {
	Status          string        `json:"status"`
	LastEventAt     string        `json:"lastEventAt,omitempty"`
	LastEvent       string        `json:"lastEvent,omitempty"`
	LastError       string        `json:"lastError,omitempty"`
	PlanStep        string        `json:"planStep,omitempty"`
	Question        string        `json:"question,omitempty"`
	BackgroundTasks []inspectTask `json:"backgroundTasks,omitempty"`
	// OwnTurn is a turn the agent runs on its own now, though the session's
	// status has ended: a timer's run or its follow-up after background work.
	OwnTurn *ownTurnProgress       `json:"ownTurn,omitempty"`
	Flags   *sessionprogress.Flags `json:"flags,omitempty"`
}

type ownTurnProgress struct {
	Origin    string `json:"origin"`
	StartedAt string `json:"startedAt,omitempty"`
	Prompt    string `json:"prompt,omitempty"`
}

// listSessionProgress is what a list_sessions row carries: the last event and
// the event-log detector flags. get_session adds the rest.
type listSessionProgress struct {
	LastEventAt string                 `json:"lastEventAt,omitempty"`
	LastEvent   string                 `json:"lastEvent,omitempty"`
	Flags       *sessionprogress.Flags `json:"flags,omitempty"`
}

// progressFacts builds the progress object for a session or native chat. A
// native chat has no tool-call log in Foundry, so it reports its last
// transcript message and error only.
func (s *Server) progressFacts(ctx context.Context, target inspectTarget) *sessionProgress {
	if target.chat != nil {
		return chatProgress(target.chat.Status, target.events())
	}
	session := *target.session
	progress := &sessionProgress{Status: session.Status}
	if at, label := sessionprogress.LastEvent(session.Events); at != "" {
		progress.LastEventAt, progress.LastEvent = inspectTime(at), label
	}
	visible := sessionInspectEvents(session.Events)
	for index := len(visible) - 1; index >= 0; index-- {
		if visible[index].level == "error" {
			progress.LastError = oneLine(visible[index].detail, progressErrorLimit)
			break
		}
	}
	progress.PlanStep = sessionprogress.PlanStep(session.Events)
	if message, waiting := s.waitingQuestion(ctx, session); waiting && len(message.Questions) > 0 {
		progress.Question = oneLine(message.Questions[0].Title, progressQuestionLimit)
	}
	progress.BackgroundTasks = openBackgroundTasks(session.Events)
	if fire := sessionprogress.OwnTurn(session.Events); fire != nil {
		progress.OwnTurn = &ownTurnProgress{Origin: fire.Origin, StartedAt: inspectTime(fire.StartedAt), Prompt: oneLine(fire.Prompt, progressQuestionLimit)}
	}
	flags := sessionprogress.Detect(session.Events, session.Status, time.Now().UTC())
	if !flags.Empty() {
		progress.Flags = &flags
	}
	return progress
}

func chatProgress(status string, events []inspectEvent) *sessionProgress {
	progress := &sessionProgress{Status: status}
	if len(events) > 0 {
		last := events[len(events)-1]
		progress.LastEventAt, progress.LastEvent = inspectTime(last.at), last.label
	}
	for index := len(events) - 1; index >= 0; index-- {
		if events[index].level == "error" {
			progress.LastError = oneLine(events[index].detail, progressErrorLimit)
			break
		}
	}
	return progress
}

// toolCallsFor is the tool-call log of a Foundry session; a native chat keeps
// no such log here.
func toolCallsFor(target inspectTarget) []sessionprogress.ToolCall {
	if target.chat != nil {
		return nil
	}
	return sessionprogress.ToolCalls(target.session.Events)
}

// toolCallPage is one page of a session's tool calls: the newest by default,
// forward from offset when asked.
type toolCallPageAnswer struct {
	SessionID      string                     `json:"sessionId"`
	Progress       *sessionProgress           `json:"progress"`
	ToolCalls      []sessionprogress.ToolCall `json:"toolCalls"`
	TotalToolCalls int                        `json:"totalToolCalls"`
	Earlier        string                     `json:"earlier,omitempty"`
	Later          string                     `json:"later,omitempty"`
}

func toolCallPage(id string, progress *sessionProgress, calls []sessionprogress.ToolCall, args map[string]json.RawMessage) toolCallPageAnswer {
	total := len(calls)
	limit := min(max(mcpArgNumber(args, "limit", progressDefaultCalls), 1), progressMaxCalls)
	var start, end int
	if _, given := args["offset"]; given {
		start = min(max(mcpArgNumber(args, "offset", 0), 0), total)
		end = min(start+limit, total)
	} else {
		end = total
		start = max(end-limit, 0)
	}
	answer := toolCallPageAnswer{SessionID: id, Progress: progress, ToolCalls: []sessionprogress.ToolCall{}, TotalToolCalls: total}
	answer.ToolCalls = append(answer.ToolCalls, calls[start:end]...)
	if start > 0 {
		answer.Earlier = fmt.Sprintf("offset=%d limit=%d", max(start-limit, 0), limit)
	}
	if end < total {
		answer.Later = fmt.Sprintf("offset=%d", end)
	}
	return answer
}

func (s *Server) readProgressForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	target, err := s.resolveInspectTarget(ctx, call.actor, mcpSessionID(call.args, "sessionId"), true)
	if err != nil {
		return "", err
	}
	answer := toolCallPage(target.id(), s.progressFacts(ctx, target), toolCallsFor(target), call.args)
	return clippedJSON(answer, call.args), nil
}

// attachListProgress adds the cheap progress line to active sessions in a
// list: their last event and the event-log detectors, read from a bounded
// window.
func (s *Server) attachListProgress(ctx context.Context, items []mcpSessionItem) {
	now := time.Now().UTC()
	for index := range items {
		// A queued session has only its input; progress describes work.
		if items[index].Status != "running" && items[index].Status != "blocked" {
			continue
		}
		events, _, err := s.store.AgentSessionEventWindow(ctx, items[index].ID, "", progressListWindow)
		if err != nil {
			continue
		}
		progress := &listSessionProgress{}
		if at, label := sessionprogress.LastEvent(events); at != "" {
			progress.LastEventAt, progress.LastEvent = inspectTime(at), label
		}
		flags := sessionprogress.Detect(events, items[index].Status, now)
		if !flags.Empty() {
			progress.Flags = &flags
		}
		if progress.LastEventAt != "" || progress.Flags != nil {
			items[index].Progress = progress
		}
	}
}
