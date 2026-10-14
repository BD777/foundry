package personalagent

import (
	"cmp"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// SettingsPath is where the person raises a limit (§9, §11).
const SettingsPath = "/assistant/settings"

// LimitError is a §9 limit the assistant reached: what it tells the person,
// with the settings link.
type LimitError struct {
	Limit string
	Max   int64
	// SettingsURL is the settings' full address, a link that works in any
	// channel; SettingsPath without one.
	SettingsURL string
}

func (e *LimitError) Error() string {
	what := map[string]string{
		"concurrentSessions":  "%d pieces of work running at once",
		"dailySessions":       "%d pieces of work started today",
		"dailyWorkspaces":     "%d new projects today",
		"weeklyWorkspaces":    "%d new projects this week",
		"hourlyTurns":         "%d replies in the last hour",
		"dailyDigestSessions": "%d project summaries today",
		"monthlyTokenBudget":  "the monthly budget of %d tokens",
	}[e.Limit]
	return fmt.Sprintf("limit reached: the person allows at most "+what+
		". Tell them plainly you cannot do more now, and that they can raise the limit in the assistant's settings ("+cmp.Or(e.SettingsURL, SettingsPath)+").", e.Max)
}

// Windows are the starts of the windows the limits count in: the last
// hour, and the current day, week (from Monday) and month in timezone (UTC
// when empty or unknown).
func Windows(now time.Time, timezone string) store.PersonalAgentWindows {
	location := time.UTC
	if timezone != "" {
		if loaded, err := time.LoadLocation(timezone); err == nil {
			location = loaded
		}
	}
	local := now.In(location)
	day := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, location)
	week := day.AddDate(0, 0, -((int(day.Weekday()) + 6) % 7))
	month := time.Date(local.Year(), local.Month(), 1, 0, 0, 0, 0, location)
	format := func(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }
	return store.PersonalAgentWindows{
		HourAgo:    format(now.Add(-time.Hour)),
		DayStart:   format(day),
		WeekStart:  format(week),
		MonthStart: format(month),
	}
}

// EffectiveLimits are the limits the server applies: a zero one is its
// default, one above its hard cap is the cap.
func EffectiveLimits(limits store.PersonalAgentLimits) store.PersonalAgentLimits {
	clamp := func(value *int, fallback, max int) {
		if *value <= 0 {
			*value = fallback
		}
		if max > 0 && *value > max {
			*value = max
		}
	}
	clamp(&limits.ConcurrentSessions, DefaultLimits.ConcurrentSessions, LimitCaps.ConcurrentSessions)
	clamp(&limits.DailySessions, DefaultLimits.DailySessions, LimitCaps.DailySessions)
	clamp(&limits.DailyWorkspaces, DefaultLimits.DailyWorkspaces, LimitCaps.DailyWorkspaces)
	clamp(&limits.WeeklyWorkspaces, DefaultLimits.WeeklyWorkspaces, LimitCaps.WeeklyWorkspaces)
	clamp(&limits.HourlyTurns, DefaultLimits.HourlyTurns, LimitCaps.HourlyTurns)
	clamp(&limits.DailyDigestSessions, DefaultLimits.DailyDigestSessions, LimitCaps.DailyDigestSessions)
	clamp(&limits.StuckAfterMinutes, DefaultLimits.StuckAfterMinutes, LimitCaps.StuckAfterMinutes)
	return limits
}

func reached(limit string, used, max int64) error {
	if max > 0 && used >= max {
		return &LimitError{Limit: limit, Max: max}
	}
	return nil
}

// CheckNewWorkspace refuses a project past the daily or weekly limit.
func CheckNewWorkspace(limits store.PersonalAgentLimits, usage store.PersonalAgentUsage) error {
	limits = EffectiveLimits(limits)
	if err := reached("dailyWorkspaces", int64(usage.WorkspacesToday), int64(limits.DailyWorkspaces)); err != nil {
		return err
	}
	return reached("weeklyWorkspaces", int64(usage.WorkspacesThisWeek), int64(limits.WeeklyWorkspaces))
}

// CheckDelegate refuses handing off more work past the concurrent, daily
// or monthly token limit.
func CheckDelegate(limits store.PersonalAgentLimits, usage store.PersonalAgentUsage) error {
	limits = EffectiveLimits(limits)
	if err := reached("concurrentSessions", int64(usage.ActiveSessions), int64(limits.ConcurrentSessions)); err != nil {
		return err
	}
	if err := reached("dailySessions", int64(usage.SessionsToday), int64(limits.DailySessions)); err != nil {
		return err
	}
	return reached("monthlyTokenBudget", usage.TokensThisMonth, limits.MonthlyTokenBudget)
}

// CheckTurn refuses an assistant turn past the hourly limit, against loops.
func CheckTurn(limits store.PersonalAgentLimits, usage store.PersonalAgentUsage) error {
	limits = EffectiveLimits(limits)
	return reached("hourlyTurns", int64(usage.TurnsThisHour), int64(limits.HourlyTurns))
}

// CheckDigest refuses a digest summary session past the daily limit.
func CheckDigest(limits store.PersonalAgentLimits, usage store.PersonalAgentUsage) error {
	limits = EffectiveLimits(limits)
	return reached("dailyDigestSessions", int64(usage.DigestSessionsToday), int64(limits.DailyDigestSessions))
}
