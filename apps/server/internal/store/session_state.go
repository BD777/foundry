package store

import (
	"context"
	"net/url"
	"regexp"
	"strings"
)

// SessionStateStore reads what a chat's side panel derives from a
// session's events — scheduled tasks, background work, recorded files,
// subagents, previews and the workspace loaded — among the events older
// than a transcript window, so the panel does not depend on which events
// a reader has loaded.
type SessionStateStore interface {
	// AgentSessionStateEvents returns, among the session's events before
	// the cursor a window returned (every event without one), one event
	// per state key (see SessionStateKey), oldest first: the newest where
	// SessionStateLatest, else the first. A task's progress and end count
	// only for a subagent whose start is among them. A cursor it cannot
	// read is ErrInvalidEventsCursor.
	AgentSessionStateEvents(ctx context.Context, sessionID string, before string) ([]AgentSessionEvent, error)
}

// State keys. A kind whose events add up (each recorded file, timer fire
// or preview) keys each event by its id; a kind whose newest event
// replaces the older ones (a snapshot, a task's progress) shares a key.
const (
	sessionStateTimers     = "timers"
	sessionStateBackground = "background"
	sessionStateFile       = "file:"
	sessionStateFire       = "fire:"
	// SessionStatePreview keys a finished run that named a local address.
	SessionStatePreview = "preview:"
	// SessionStateSource keys a loaded workspace by its path.
	SessionStateSource = "source:"
	// SessionStateSubagent keys a subagent's start by its task id.
	SessionStateSubagent = "subagent:"
	// SessionStateTask keys a task's progress and end by its task id: a
	// subagent's, or a background command's (their ends name no type).
	SessionStateTask = "task:"
)

// Event labels workers record, with the ones older workers wrote.
var (
	subtaskStartLabels    = labelSet("Starting subtask", "正在启动子任务", "Subtask started")
	subtaskProgressLabels = labelSet("Subtask running", "子任务进行中")
	subtaskEndLabels      = labelSet("Subtask completed", "子任务完成", "Subtask finished", "Subtask failed", "子任务失败")
	loadedWorkspaceLabels = labelSet("Loaded workspace", "已加载工作区")
	runFinishedLabel      = regexp.MustCompile(`(?i)\b(?:SDK|CLI|command) finished$`)
	webURL                = regexp.MustCompile(`(?i)https?://[^\s<>"']+`)
)

func labelSet(labels ...string) map[string]bool {
	set := make(map[string]bool, len(labels))
	for _, label := range labels {
		set[label] = true
	}
	return set
}

// SessionStateKey names the side-panel state an event carries, "" for
// the rest of the transcript.
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
		// Only a scheduled task's fire names its timer and shows under it.
		case metadata.TimerFire != nil && metadata.TimerFire.ID != "":
			return sessionStateFire + event.ID
		case metadata.TaskID != "" && subtaskStartLabels[label]:
			if metadata.TaskType == "local_agent" {
				return SessionStateSubagent + metadata.TaskID
			}
			return ""
		case metadata.TaskID != "" && (subtaskProgressLabels[label] || subtaskEndLabels[label]):
			return SessionStateTask + metadata.TaskID
		}
	}
	if loadedWorkspaceLabels[label] {
		if path := strings.TrimSpace(event.Detail); path != "" {
			return SessionStateSource + path
		}
		return ""
	}
	if event.Level == "info" && runFinishedLabel.MatchString(label) && hasPreviewURL(event.Detail) {
		return SessionStatePreview + event.ID
	}
	return ""
}

// SessionStateLatest reports whether the newest event of the key replaces
// the older ones. Of the other keys only one event counts: a file's, a
// fire's, a preview's own, a subagent's start, and the first time a
// workspace was loaded, which places it among the workspaces.
func SessionStateLatest(key string) bool {
	return key == sessionStateTimers || key == sessionStateBackground || strings.HasPrefix(key, SessionStateTask)
}

// hasPreviewURL reports a local web address in a finished run's detail,
// such as a dev server the run started.
func hasPreviewURL(detail string) bool {
	for _, raw := range webURL.FindAllString(detail, -1) {
		parsed, err := url.Parse(strings.TrimRight(raw, "),.;]}"))
		if err != nil {
			continue
		}
		switch strings.ToLower(parsed.Hostname()) {
		case "127.0.0.1", "localhost", "0.0.0.0", "::1":
			return true
		}
	}
	return false
}
