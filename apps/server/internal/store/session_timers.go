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

// OneTimeTimerGrace is how long past its fire time a one-time timer may
// still be listed: Claude fires a due one when the session is next idle,
// and the device delivers one no process holds once it is due; a later
// snapshot then no longer lists it. OneTimeTimerUnzonedGrace is for one
// reported without TimeZone, timed in the device's zone, which may differ
// from the agent's by up to a day.
const (
	OneTimeTimerGrace        = time.Hour
	OneTimeTimerUnzonedGrace = 48 * time.Hour
)

// Ended reports whether the session's agent no longer holds the timer, as
// far as its schedule shows: a recurring one once Expired, a one-time one
// some time after it fired (NextFireAt, or FirstSeenAt). Readers showing
// whether a session waits on a timer use it; device timer revival keeps
// using Expired, so a timer whose time passed while nothing held it is
// still delivered once. protocol sessionScheduledTimerEnded is the same.
func (timer AgentSessionScheduledTimer) Ended(now time.Time) bool {
	if timer.Recurring {
		return timer.Expired(now)
	}
	at := timer.NextFireAt
	if at == "" {
		at = timer.FirstSeenAt
	}
	fire, err := time.Parse(time.RFC3339Nano, at)
	if err != nil {
		return false
	}
	grace := OneTimeTimerUnzonedGrace
	if timer.TimeZone != "" {
		grace = OneTimeTimerGrace
	}
	return !now.Before(fire.Add(grace))
}

// Live is the schedule without its Ended timers; nil when none is left.
func (schedule *AgentSessionSchedule) Live(now time.Time) *AgentSessionSchedule {
	if schedule == nil {
		return nil
	}
	live := &AgentSessionSchedule{ReportedAt: schedule.ReportedAt, Timers: make([]AgentSessionScheduledTimer, 0, len(schedule.Timers))}
	for _, timer := range schedule.Timers {
		if !timer.Ended(now) {
			live.Timers = append(live.Timers, timer)
		}
	}
	if len(live.Timers) == 0 {
		return nil
	}
	return live
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
			ID: task.ID, Kind: task.Kind, Schedule: task.Schedule, Recurring: task.Recurring, TimeZone: task.TimeZone, NextFireAt: task.NextFireAt,
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
