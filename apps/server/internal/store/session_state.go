package store

import (
	"context"
	"net/url"
	"regexp"
	"strings"
)

// SessionStateStore reads what a chat's side panel derives from a
// session's events — scheduled tasks, background work, recorded files,
// subagents, previews, the workspace loaded, how full the context is and
// what each turn used — so the panel does not depend on which events a
// reader has loaded (DeriveSessionPanel).
type SessionStateStore interface {
	// AgentSessionStateEvents returns, among the session's events before
	// the cursor a window returned (every event without one), one event
	// per state key (see SessionStateKey), oldest first: the newest where
	// SessionStateLatest, else the first. A task's progress and end count
	// only for a subagent whose start is among them. An input comes
	// without its message (SessionStateInput). A cursor it cannot read is
	// ErrInvalidEventsCursor.
	AgentSessionStateEvents(ctx context.Context, sessionID string, before string) ([]AgentSessionEvent, error)
	SessionFrameStore
}

// State keys. A kind whose events add up (each recorded file, timer fire,
// preview, turn's usage, compaction or input) keys each event by its id; a
// kind whose newest event replaces the older ones (a snapshot, a task's
// progress, the context's size) shares a key.
const (
	sessionStateTimers     = "timers"
	sessionStateBackground = "background"
	sessionStateFile       = "file:"
	sessionStateFire       = "fire:"
	// SessionStateContext keys a report of the context's size; one that
	// names the model's window is SessionStateContextWindow, so the newest
	// window stays known.
	SessionStateContext       = "context"
	SessionStateContextWindow = "context:window"
	// SessionStateRequest keys a model request's usage report.
	SessionStateRequest = "request"
	// SessionStateCompaction keys the runtime compacting the context.
	SessionStateCompaction = "compaction:"
	// SessionStateTurn keys the usage of a turn, on the event that ended it.
	SessionStateTurn = "turn:"
	// SessionStatePreview keys a finished run that named a local address.
	SessionStatePreview = "preview:"
	// SessionStateSource keys a loaded workspace by its path.
	SessionStateSource = "source:"
	// SessionStateSubagent keys a subagent's start by its task id.
	SessionStateSubagent = "subagent:"
	// SessionStateFrame keys every tool frame: the side panel reads the
	// newest; the frames are listed on their own (SessionFrameStore).
	SessionStateFrame = "frame"
	// SessionStateTask keys a task's progress and end by its task id: a
	// subagent's, or a background command's (their ends name no type).
	SessionStateTask = "task:"
	// SessionStateInput keys each input by its event id. Only when it came
	// counts (a timer's run ends at the next input), so the state carries
	// it without its message.
	SessionStateInput = "input:"
	// SessionStateProcess keys a Claude process starting for the session.
	SessionStateProcess = "process"
)

// SubagentTaskType is the task type of Claude's subagents; their devices
// list only these.
const SubagentTaskType = "local_agent"

// SubtaskPhase is what a task event (a subagent's, or a background
// command's) says of its task.
type SubtaskPhase int

const (
	NotSubtask SubtaskPhase = iota
	SubtaskStarted
	SubtaskProgressed
	SubtaskCompleted
	SubtaskFailed
)

// SubtaskEventPhase is the one reading of the task events workers record:
// every reader of a session's subagents and tasks matches them here.
func SubtaskEventPhase(event AgentSessionEvent) SubtaskPhase {
	if event.Metadata == nil || event.Metadata.TaskID == "" {
		return NotSubtask
	}
	switch strings.TrimSpace(event.Label) {
	case ProcessLabelStartingSubtask:
		return SubtaskStarted
	case ProcessLabelSubtaskRunning:
		return SubtaskProgressed
	case ProcessLabelSubtaskCompleted:
		return SubtaskCompleted
	case ProcessLabelSubtaskFailed:
		return SubtaskFailed
	}
	return NotSubtask
}

var webURL = regexp.MustCompile(`(?i)https?://[^\s<>"']+`)

// SessionStateKey names the side-panel state an event carries, "" for
// the rest of the transcript. The panel (DeriveSessionPanel) reads only
// these events.
func SessionStateKey(event AgentSessionEvent) string {
	metadata := event.Metadata
	label := strings.TrimSpace(event.Label)
	if metadata != nil {
		switch {
		case metadata.TimerSnapshot != nil:
			return sessionStateTimers
		case metadata.BackgroundTaskSnapshot != nil:
			return sessionStateBackground
		case metadata.SessionFile != nil && metadata.SessionFile.Path != "":
			return sessionStateFile + event.ID
		case metadata.ToolFrame != nil && metadata.ToolFrame.ID != "":
			return SessionStateFrame
		// Only a scheduled task's fire names its timer and shows under it.
		case metadata.TimerFire != nil && metadata.TimerFire.ID != "":
			return sessionStateFire + event.ID
		}
		switch SubtaskEventPhase(event) {
		case SubtaskStarted:
			if metadata.TaskType == SubagentTaskType {
				return SessionStateSubagent + metadata.TaskID
			}
			return ""
		case SubtaskProgressed, SubtaskCompleted, SubtaskFailed:
			return SessionStateTask + metadata.TaskID
		}
		switch usage := metadata.ContextUsage; {
		case usage != nil && usage.Compaction != nil:
			return SessionStateCompaction + event.ID
		case usage != nil && usage.ContextWindow != nil && *usage.ContextWindow != 0:
			return SessionStateContextWindow
		case usage != nil:
			return SessionStateContext
		case metadata.RequestUsage != nil:
			return SessionStateRequest
		// A finished run that names a preview stays one (its usage comes
		// with it).
		case metadata.TurnUsage != nil && !isPreview(event, label):
			return SessionStateTurn + event.ID
		}
	}
	switch {
	case label == ProcessLabelLoadedWorkspace:
		if path := strings.TrimSpace(event.Detail); path != "" {
			return SessionStateSource + path
		}
		return ""
	case label == EventLabelUserMessage:
		return SessionStateInput + event.ID
	case label == EventLabelClaudeProcessStarted:
		return SessionStateProcess
	case isPreview(event, label):
		return SessionStatePreview + event.ID
	}
	return ""
}

func isPreview(event AgentSessionEvent, label string) bool {
	return event.Level == "info" && IsTurnEndLabel(label) && hasPreviewURL(event.Detail)
}

// SessionStateLatest reports whether the newest event of the key replaces
// the older ones. Of the other keys only one event counts: a file's, a
// fire's, a preview's, a turn's, a compaction's or an input's own, a
// subagent's start, and the first time a workspace was loaded, which places
// it among the workspaces.
func SessionStateLatest(key string) bool {
	switch key {
	case sessionStateTimers, sessionStateBackground, SessionStateContext, SessionStateContextWindow, SessionStateRequest, SessionStateFrame, SessionStateProcess:
		return true
	}
	return strings.HasPrefix(key, SessionStateTask)
}

// previewURLs are the local web addresses in text, such as a dev server a
// run started, in order.
func previewURLs(text string) []string {
	var found []string
	for _, raw := range webURL.FindAllString(text, -1) {
		trimmed := strings.TrimRight(raw, "),.;]}")
		parsed, err := url.Parse(trimmed)
		if err != nil {
			continue
		}
		switch strings.ToLower(parsed.Hostname()) {
		case "127.0.0.1", "localhost", "0.0.0.0", "::1":
			found = append(found, trimmed)
		}
	}
	return found
}

// hasPreviewURL reports a local web address in a finished run's detail.
func hasPreviewURL(detail string) bool {
	return len(previewURLs(detail)) > 0
}
