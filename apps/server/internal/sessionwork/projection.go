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
	if session.ThreadID != "" {
		return session.ThreadID
	}
	return session.ID
}

func Base(session store.AgentSession, kind, source, sourceID, title string) store.SessionWork {
	return store.SessionWork{ID: ID(session.ID, source, sourceID), SessionID: session.ID, ThreadID: Thread(session), WorkspaceID: session.WorkspaceID, DeviceID: session.DeviceID, Kind: kind, Source: source, SourceID: sourceID, Title: title, Management: "managed", DesiredState: "enabled", AllowedActions: []string{"stop"}, Observation: store.WorkObservation{Status: "unknown", At: time.Now().UTC().Format(time.RFC3339Nano)}}
}
func Timer(session store.AgentSession, timer store.SessionKeptTimer) store.SessionWork {
	w := Base(session, "schedule", "claude", timer.ID, strings.SplitN(timer.Prompt, "\n", 2)[0])
	w.CreatedAt = timer.FirstSeenAt
	w.Spec = store.WorkSpec{Schedule: timer.Schedule, Recurring: timer.Recurring, Prompt: timer.Prompt, NativeSessionID: session.NativeSessionID, Target: "continue_thread"}
	if first, err := time.Parse(time.RFC3339Nano, timer.FirstSeenAt); err == nil && timer.Recurring {
		w.Spec.ExpiresAt = first.Add(store.ClaudeRecurringTimerMaxAge).Format(time.RFC3339Nano)
	}
	w.AllowedActions = []string{"pause", "resume", "stop", "remove", "run"}
	w.Observation.NextFireAt = timer.NextFireAt
	return w
}

// FromEvents normalizes the latest background inventory and native subagents;
// callers insert only missing identities, never overwrite a control with it.
func FromEvents(session store.AgentSession) []store.SessionWork {
	items := map[string]store.SessionWork{}
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
				w := Base(session, kind, "claude", task.ID, task.Description)
				w.CreatedAt = task.StartedAt
				w.Spec.NativeSessionID = session.NativeSessionID
				status := task.Status
				if status == "ended" {
					status = "unknown"
				}
				w.Observation = store.WorkObservation{Status: status, At: e.At, StartedAt: task.StartedAt, EndedAt: task.EndedAt, ExitCode: task.ExitCode}
				items[task.ID] = w
			}
		}
		if m.TaskType == "local_agent" && m.TaskID != "" && (strings.Contains(e.Label, "Starting subtask") || e.Label == "正在启动子任务" || e.Label == "Subtask started") {
			if _, exists := items[m.TaskID]; !exists {
				w := Base(session, "agent", "claude", m.TaskID, e.Detail)
				w.CreatedAt = e.At
				w.Observation.Status = "running"
				w.Observation.At = e.At
				items[m.TaskID] = w
			}
		}
		if w, ok := items[m.TaskID]; ok && (strings.Contains(e.Label, "Subtask completed") || strings.Contains(e.Label, "Subtask failed") || e.Label == "子任务完成" || e.Label == "子任务失败" || e.Label == "Subtask finished") {
			w.Observation.Status = "completed"
			if e.Level == "error" || e.Label == "子任务失败" || strings.Contains(e.Label, "Subtask failed") {
				w.Observation.Status = "failed"
			}
			w.Observation.EndedAt = e.At
			w.Observation.At = e.At
			items[m.TaskID] = w
		}
	}
	result := make([]store.SessionWork, 0, len(items))
	for _, w := range items {
		result = append(result, w)
	}
	return result
}
