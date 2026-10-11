import { claudeTimerNextFire } from "./cron.js";
import type { AgentScheduledTask, AgentSessionSchedule } from "./index.js";

/**
 * A session's schedule from a timer snapshot its device reported at `at`;
 * undefined when it holds no timers. The server derives the same
 * (store.SessionScheduleFromSnapshot); viewers apply a pushed snapshot with
 * this until they read the session again.
 */
export function sessionScheduleFromSnapshot(
  tasks: readonly AgentScheduledTask[],
  at: string,
): AgentSessionSchedule | undefined {
  if (tasks.length === 0) return undefined;
  return {
    reportedAt: at,
    timers: tasks.map((task) => ({
      id: task.id,
      kind: task.kind,
      schedule: task.schedule,
      recurring: task.recurring,
      ...(task.nextFireAt ? { nextFireAt: task.nextFireAt } : {}),
    })),
  };
}

/**
 * When the session's agent is woken next, seen from `now`: the earliest of
 * its timers, recomputed from their schedules (the reported times go stale).
 */
export function sessionScheduleNextFire(
  schedule: AgentSessionSchedule,
  now: Date = new Date(),
): Date | undefined {
  let earliest: Date | undefined;
  for (const timer of schedule.timers) {
    const reported = timer.nextFireAt ? new Date(timer.nextFireAt) : undefined;
    const next =
      claudeTimerNextFire(timer, now) ??
      (reported && !Number.isNaN(reported.getTime()) ? reported : undefined);
    if (next && (!earliest || next.getTime() < earliest.getTime()))
      earliest = next;
  }
  return earliest;
}
