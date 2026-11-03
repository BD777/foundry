package store

import "time"

// ClaudeRecurringTimerMaxAge is how long a recurring timer lives; Claude
// Code then deletes it.
const ClaudeRecurringTimerMaxAge = 7 * 24 * time.Hour

// Expired reports whether the timer ended by `now`: a recurring one a week
// after it was first seen.
func (timer AgentSessionScheduledTimer) Expired(now time.Time) bool {
	if !timer.Recurring {
		return false
	}
	seen, err := time.Parse(time.RFC3339Nano, timer.FirstSeenAt)
	return err == nil && !now.Before(seen.Add(ClaudeRecurringTimerMaxAge))
}

// SessionScheduleFromSnapshot is a session's schedule from a timer snapshot
// reported at `at`, after the `previous` one; nil when it holds no timers.
// A timer the previous schedule held keeps when it was first seen.
func SessionScheduleFromSnapshot(previous *AgentSessionSchedule, tasks []AgentScheduledTask, at string) *AgentSessionSchedule {
	if len(tasks) == 0 {
		return nil
	}
	seen := map[string]string{}
	if previous != nil {
		for _, timer := range previous.Timers {
			if timer.FirstSeenAt != "" {
				seen[timer.ID] = timer.FirstSeenAt
			}
		}
	}
	schedule := &AgentSessionSchedule{ReportedAt: at, Timers: make([]AgentSessionScheduledTimer, 0, len(tasks))}
	for _, task := range tasks {
		firstSeenAt := seen[task.ID]
		if firstSeenAt == "" {
			firstSeenAt = at
		}
		schedule.Timers = append(schedule.Timers, AgentSessionScheduledTimer{
			ID: task.ID, Kind: task.Kind, Schedule: task.Schedule, Recurring: task.Recurring, NextFireAt: task.NextFireAt,
			FirstSeenAt: firstSeenAt,
		})
	}
	return schedule
}

// SessionTimers is a session's timers: the timers of its schedule with
// their prompts, in the native session they live in. Its device's work
// reads import them into session work.
type SessionTimers struct {
	SessionID       string             `json:"sessionId"`
	NativeSessionID string             `json:"nativeSessionId"`
	Timers          []SessionKeptTimer `json:"timers"`
}

// SessionKeptTimer is a timer of a session's schedule with its prompt.
type SessionKeptTimer struct {
	AgentScheduledTask
	FirstSeenAt string `json:"firstSeenAt"`
}
