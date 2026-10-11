import { claudeRecurringTimerMaxAgeMs, claudeTimerNextFire } from "./cron.js";
import type {
  AgentScheduledTask,
  AgentSessionSchedule,
  AgentSessionScheduledTimer,
} from "./index.js";

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
 * When the session's agent is woken next, seen from `now`: the earliest of
 * its live timers, recomputed from their schedules (the reported times go
 * stale).
 */
export function sessionScheduleNextFire(
  schedule: AgentSessionSchedule,
  now: Date = new Date(),
): Date | undefined {
  let earliest: Date | undefined;
  for (const timer of schedule.timers) {
    if (sessionScheduledTimerExpired(timer, now)) continue;
    const reported = timer.nextFireAt ? new Date(timer.nextFireAt) : undefined;
    const next =
      claudeTimerNextFire(timer, now) ??
      (reported && !Number.isNaN(reported.getTime()) ? reported : undefined);
    if (next && (!earliest || next.getTime() < earliest.getTime()))
      earliest = next;
  }
  return earliest;
}
