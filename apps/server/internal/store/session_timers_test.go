package store

import (
	"testing"
	"time"
)

// A one-time timer ends an hour after it fired, one recorded without its
// zone two days after, a recurring one a week after it was first seen; the
// schedule's live timers are the others (protocol sessionScheduledTimerEnded).
func TestScheduledTimerEndedAndLive(t *testing.T) {
	now := time.Date(2026, 11, 9, 3, 30, 0, 0, time.UTC)
	at := func(d time.Duration) string { return now.Add(d).Format(time.RFC3339Nano) }
	fired := AgentSessionScheduledTimer{ID: "fired", Schedule: "46 7 * * *", TimeZone: "America/Toronto", NextFireAt: at(-2 * time.Hour), FirstSeenAt: at(-3 * time.Hour)}
	due := AgentSessionScheduledTimer{ID: "due", Schedule: "20 22 8 11 *", TimeZone: "America/Toronto", NextFireAt: at(-10 * time.Minute), FirstSeenAt: at(-time.Hour)}
	ahead := AgentSessionScheduledTimer{ID: "ahead", Schedule: "35 22 8 11 *", TimeZone: "America/Toronto", NextFireAt: at(5 * time.Minute), FirstSeenAt: at(-time.Minute)}
	// The record that left a chat's clock on: no zone, a time read 13 hours off.
	legacy := AgentSessionScheduledTimer{ID: "14db6a22", Schedule: "46 7 * * *", NextFireAt: "2026-11-04T23:46:00.000Z", FirstSeenAt: "2026-11-05T12:25:34.266657679Z"}
	recentLegacy := AgentSessionScheduledTimer{ID: "recent", Schedule: "46 7 * * *", NextFireAt: at(-24 * time.Hour)}
	recurring := AgentSessionScheduledTimer{ID: "cron", Schedule: "*/30 * * * *", Recurring: true, NextFireAt: at(-3 * 24 * time.Hour), FirstSeenAt: at(-3 * 24 * time.Hour)}
	for _, check := range []struct {
		timer AgentSessionScheduledTimer
		ended bool
	}{{fired, true}, {due, false}, {ahead, false}, {legacy, true}, {recentLegacy, false}, {recurring, false}} {
		if got := check.timer.Ended(now); got != check.ended {
			t.Errorf("%s ended = %v, want %v", check.timer.ID, got, check.ended)
		}
	}
	if fired.Expired(now) || legacy.Expired(now) {
		t.Fatal("revival still sees a one-time timer whose time passed (Expired)")
	}

	live := (&AgentSessionSchedule{ReportedAt: at(-time.Hour), Timers: []AgentSessionScheduledTimer{fired, ahead, legacy}}).Live(now)
	if live == nil || len(live.Timers) != 1 || live.Timers[0].ID != "ahead" {
		t.Fatalf("live = %+v", live)
	}
	if (&AgentSessionSchedule{Timers: []AgentSessionScheduledTimer{fired, legacy}}).Live(now) != nil {
		t.Fatal("a schedule of ended timers is none")
	}
	var none *AgentSessionSchedule
	if none.Live(now) != nil {
		t.Fatal("no schedule stays none")
	}
}

// A snapshot's timers keep the zone their cron fields are in.
func TestSessionScheduleKeepsTimerZone(t *testing.T) {
	schedule := SessionScheduleFromSnapshot(nil, []AgentScheduledTask{{ID: "w", Kind: "wakeup", Schedule: "46 7 5 11 *", TimeZone: "America/Toronto", NextFireAt: "2026-11-05T12:46:00.000Z"}}, "2026-11-05T12:25:34Z")
	if schedule == nil || schedule.Timers[0].TimeZone != "America/Toronto" {
		t.Fatalf("schedule = %+v", schedule)
	}
}
