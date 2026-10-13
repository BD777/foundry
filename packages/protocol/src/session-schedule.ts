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
