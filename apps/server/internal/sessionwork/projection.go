// Package sessionwork owns work identity and source normalization. Transport and
// native execution stay outside this package.
package sessionwork

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func ID(sessionID, source, sourceID string) string {
	sum := sha256.Sum256([]byte(sessionID + "\x00" + source + "\x00" + sourceID))
	return "work_" + hex.EncodeToString(sum[:16])
}
func Thread(session store.AgentSession) string {
	return session.ID
}

func Base(session store.AgentSession, kind, source, sourceID, title string) store.SessionWork {
	return store.SessionWork{ID: ID(session.ID, source, sourceID), SessionID: session.ID, ThreadID: Thread(session), WorkspaceID: session.WorkspaceID, DeviceID: session.DeviceID, Kind: kind, Source: source, SourceID: sourceID, Title: title, Management: "managed", DesiredState: "enabled", AllowedActions: []string{"stop"}, Observation: store.WorkObservation{Status: "unknown", At: time.Now().UTC().Format(time.RFC3339Nano)}}
}
func NativeInfo(session store.AgentSession, id, discovery string) *store.NativeWorkInfo {
	return &store.NativeWorkInfo{Runtime: session.Provider, Version: "unknown", SessionID: session.NativeSessionID, TaskID: id, Discovery: discovery, Observation: "available", Controls: map[string]string{"stop": "unavailable", "pause": "unsupported", "resume": "unsupported"}}
}
func Timer(session store.AgentSession, timer store.SessionKeptTimer) store.SessionWork {
	w := Base(session, "schedule", "claude", timer.ID, strings.SplitN(timer.Prompt, "\n", 2)[0])
	w.CreatedAt = timer.FirstSeenAt
	w.Spec = store.WorkSpec{Schedule: timer.Schedule, Recurring: timer.Recurring, Prompt: timer.Prompt, NativeSessionID: session.NativeSessionID, Target: "continue_thread"}
	if first, err := time.Parse(time.RFC3339Nano, timer.FirstSeenAt); err == nil && timer.Recurring {
		w.Spec.ExpiresAt = first.Add(store.ClaudeRecurringTimerMaxAge).Format(time.RFC3339Nano)
	}
	w.Management = "observed"
	w.Native = NativeInfo(session, timer.ID, "transcript timer snapshot")
	w.AllowedActions = []string{}
	w.Observation.Status = "idle"
	w.Observation.NextFireAt = timer.NextFireAt
	return w
}

// FromEvents normalizes the latest background inventory, native subagents
// and the ends of tasks; callers insert only missing identities, never
// overwrite a control with it. How a task ended is, first, what the inventory
// says; then its lifecycle end, which also covers a task the inventory no
// longer lists (it keeps only the most recent finished ones).
func FromEvents(session store.AgentSession) []store.SessionWork {
	items := map[string]store.SessionWork{}
	// Tasks whose outcome the inventory names; their lifecycle end only adds
	// what the inventory lacks.
	inventoried := map[string]bool{}
	now := time.Now().UTC()
	for _, e := range session.Events {
		m := e.Metadata
		if m == nil {
			continue
		}
		if m.BackgroundTaskSnapshot != nil {
			for _, task := range *m.BackgroundTaskSnapshot {
				kind := "process"
				if task.Kind == "subagent" {
					kind = "agent"
				}
				known, exists := items[task.ID]
				knownEnd := exists && terminalWorkStatus(known.Observation.Status)
				w := Base(session, kind, "claude", task.ID, task.Description)
				w.CreatedAt = task.StartedAt
				w.Native = NativeInfo(session, task.ID, "transcript task lifecycle")
				w.Management = "observed"
				w.AllowedActions = []string{}
				w.Spec.NativeSessionID = session.NativeSessionID
				status, endedAt, exitCode, at := task.Status, task.EndedAt, task.ExitCode, e.At
				switch {
				// "ended" means the task's outcome was not reported: a
				// lifecycle end that named it wins, with its time.
				case status == "ended" && knownEnd:
					status, endedAt, at = known.Observation.Status, firstNonEmpty(known.Observation.EndedAt, endedAt), known.Observation.At
					if exitCode == nil {
						exitCode = known.Observation.ExitCode
					}
				// An ending task is history, not a live unknown.
				case status == "ended":
					status = "stopped"
				case knownEnd:
					endedAt = firstNonEmpty(endedAt, known.Observation.EndedAt)
					if exitCode == nil {
						exitCode = known.Observation.ExitCode
					}
				}
				inventoried[task.ID] = terminalWorkStatus(task.Status)
				if terminalWorkStatus(status) && endedAt != "" {
					// The task's end is the observation time. A later
					// inventory read does not move a finished task forward.
					at = endedAt
				}
				w.Observation = store.WorkObservation{
					Status: status, At: boundedObservationAt(at, now),
					StartedAt: task.StartedAt, EndedAt: endedAt, ExitCode: exitCode,
				}
				items[task.ID] = w
			}
		}
		phase := store.SubtaskEventPhase(e)
		if m.TaskType == store.SubagentTaskType && phase == store.SubtaskStarted {
			if _, exists := items[m.TaskID]; !exists {
				w := Base(session, "agent", "claude", m.TaskID, e.Detail)
				w.CreatedAt = e.At
				w.Native = NativeInfo(session, m.TaskID, "transcript agent lifecycle")
				w.Management = "observed"
				w.AllowedActions = []string{}
				w.Observation.Status = "running"
				w.Observation.At = boundedObservationAt(e.At, now)
				items[m.TaskID] = w
			}
		}
		if phase != store.SubtaskCompleted && phase != store.SubtaskFailed {
			continue
		}
		w, ok := items[m.TaskID]
		if !ok {
			kind := "process"
			if m.TaskType == store.SubagentTaskType {
				kind = "agent"
			}
			w = Base(session, kind, "claude", m.TaskID, e.Detail)
			w.Native = NativeInfo(session, m.TaskID, "transcript task lifecycle")
			w.Management = "observed"
			w.AllowedActions = []string{}
			w.Spec.NativeSessionID = session.NativeSessionID
		}
		if w.Observation.ExitCode == nil {
			w.Observation.ExitCode = m.ExitCode
		}
		if inventoried[m.TaskID] {
			w.Observation.EndedAt = firstNonEmpty(w.Observation.EndedAt, e.At)
		} else {
			w.Observation.Status = taskEndStatus(e, phase)
			w.Observation.EndedAt = e.At
			w.Observation.At = boundedObservationAt(e.At, now)
		}
		items[m.TaskID] = w
	}
	result := make([]store.SessionWork, 0, len(items))
	for _, w := range items {
		result = append(result, w)
	}
	return result
}

// taskEndStatus is how a task's lifecycle end says it ended: the native
// status when the device reported it; before that, a stopped task's end came
// as a failure.
func taskEndStatus(e store.AgentSessionEvent, phase store.SubtaskPhase) string {
	if terminalWorkStatus(e.Metadata.TaskStatus) {
		return e.Metadata.TaskStatus
	}
	if e.Level == "error" || phase == store.SubtaskFailed {
		return "failed"
	}
	return "completed"
}

func terminalWorkStatus(status string) bool {
	return status == "completed" || status == "failed" || status == "stopped"
}

func firstNonEmpty(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

// boundedObservationAt canonicalizes a transcript instant and prevents clock
// skew from placing an observation after the server read that imported it.
func boundedObservationAt(value string, now time.Time) string {
	at, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return value
	}
	if at.After(now) {
		at = now
	}
	return at.UTC().Format(time.RFC3339Nano)
}
