import { claudeRecurringTimerMaxAgeMs } from "./cron.js";
import type {
  AgentScheduledTask,
  AgentSessionSchedule,
  AgentSessionScheduledTimer,
} from "./session.js";

/**
 * A session's schedule from a timer snapshot its device reported at `at`,
 * after the `previous` one; undefined when it holds no timers. A timer the
 * previous schedule held keeps when it was first seen. The server derives
 * the same (store.SessionScheduleFromSnapshot); viewers apply a pushed
 * snapshot with this until they read the session again.
 */
export function sessionScheduleFromSnapshot(
  tasks: readonly AgentScheduledTask[],
  at: string,
  previous?: AgentSessionSchedule,
): AgentSessionSchedule | undefined {
  if (tasks.length === 0) return undefined;
  const seen = new Map(
    (previous?.timers ?? []).map((timer) => [timer.id, timer.firstSeenAt]),
  );
  return {
    reportedAt: at,
    timers: tasks.map((task) => ({
      id: task.id,
      kind: task.kind,
      schedule: task.schedule,
      recurring: task.recurring,
      ...(task.timeZone ? { timeZone: task.timeZone } : {}),
      ...(task.nextFireAt ? { nextFireAt: task.nextFireAt } : {}),
      firstSeenAt: seen.get(task.id) || at,
    })),
  };
}

/** Whether a recurring timer ended: Claude Code deletes it after a week. */
export function sessionScheduledTimerExpired(
  timer: AgentSessionScheduledTimer,
  now: Date = new Date(),
): boolean {
  if (!timer.recurring || !timer.firstSeenAt) return false;
  const seen = Date.parse(timer.firstSeenAt);
  return (
    Number.isFinite(seen) &&
    now.getTime() >= seen + claudeRecurringTimerMaxAgeMs
  );
}

/**
 * A one-time timer this long past its fire time is over: Claude fires a due
 * one when the session is next idle and drops it, and the device delivers
 * one no process holds once it is due; either way a later snapshot no
 * longer lists it. One still listed after this is a leftover of a process
 * that ended without reporting again.
 */
export const oneTimeTimerGraceMs = 60 * 60_000;

/**
 * A one-time timer reported without `timeZone` was timed in the device's
 * zone, which may differ from the agent's by up to a day.
 */
export const oneTimeTimerUnzonedGraceMs = 2 * 24 * 60 * 60_000;

/**
 * Whether the session's agent no longer holds the timer, as far as its
 * schedule shows: a recurring one a week after it was first seen
 * (sessionScheduledTimerExpired), a one-time one some time after it fired
 * (its `nextFireAt`, or when it was first seen). Readers showing whether a
 * session waits on a timer use this; the device still delivers a timer
 * whose time passed while nothing held it (its own record decides).
 * store.AgentSessionScheduledTimer.Ended is the same rule.
 */
export function sessionScheduledTimerEnded(
  timer: AgentSessionScheduledTimer,
  now: Date = new Date(),
): boolean {
  if (timer.recurring) return sessionScheduledTimerExpired(timer, now);
  const fire = Date.parse(timer.nextFireAt || timer.firstSeenAt || "");
  if (!Number.isFinite(fire)) return false;
  const grace = timer.timeZone
    ? oneTimeTimerGraceMs
    : oneTimeTimerUnzonedGraceMs;
  return now.getTime() >= fire + grace;
}
