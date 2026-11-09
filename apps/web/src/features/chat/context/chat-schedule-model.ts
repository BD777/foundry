import type {
  AgentSession,
  AgentSessionPanel,
  AgentSessionSchedule,
  AgentScheduledTask,
} from "@bd777/foundry-protocol";
import {
  claudeTimerNextFire,
  humanizeCron,
  sessionScheduledTimerEnded,
  type AgentSessionScheduledTimer,
  type ClaudeTimerWake,
} from "@bd777/foundry-protocol";
import type { WindowedAgentSession } from "../../../api";
import type { ChatTimerFire, ChatTimerItem } from "../chat-types";
import { i18n } from "../../../i18n";
import { isSessionLive } from "../../../lib/session-status";
import { noteTime } from "../chat-time";

/**
 * The schedule in the viewer's language, rebuilt from the cron expression
 * rather than the worker's stored (Chinese) humanSchedule. One-off times are
 * resolved from the snapshot's time, as the worker did when recording it,
 * in the zone of the agent that holds the timer.
 */
function timerScheduleLabel(task: AgentScheduledTask, snapshotAt: string) {
  const from = new Date(snapshotAt);
  return humanizeCron(
    task.schedule,
    task.recurring,
    Number.isNaN(from.getTime()) ? new Date() : from,
    i18n.language === "zh-CN" ? "zh-CN" : "en",
    task.timeZone,
  );
}

function sessionPanel(session: AgentSession): AgentSessionPanel | undefined {
  return (session as WindowedAgentSession).panel;
}

/** Each timer's last wake, as the session's panel says it. */
function panelWakes(
  panel: AgentSessionPanel | undefined,
): Map<string, ClaudeTimerWake> {
  return new Map(
    (panel?.timerWakes ?? []).map((wake) => [
      wake.id,
      { firedAt: new Date(wake.firedAt) },
    ]),
  );
}

/** When a timer that fell due on an idle session counts as not yet run. */
const timerDueGraceMs = 2 * 60_000;

/**
 * When a timer runs next, as Claude Code will run it (claudeTimerNextFire):
 * `due` when its time passed while the session was busy, so it runs when
 * the current turn ends. A recurring time that passed while the session
 * was idle ran, in a run these events do not show: its next time follows
 * from now.
 */
export function timerNextRun(
  timer: AgentSessionScheduledTimer,
  wake: ClaudeTimerWake,
  busy: boolean,
  now: Date = new Date(),
): { at?: Date; due: boolean } {
  const next = claudeTimerNextFire(timer, now, wake);
  if (!next || next.getTime() > now.getTime()) return { at: next, due: false };
  if (
    timer.recurring &&
    !busy &&
    now.getTime() - next.getTime() > timerDueGraceMs
  )
    return { at: claudeTimerNextFire(timer, now), due: false };
  return { at: next, due: true };
}

export function projectSessionTimers(session: AgentSession): ChatTimerItem[] {
  const panel = sessionPanel(session);
  if (!panel || panel.timers.length === 0) return [];
  const wakes = panelWakes(panel);
  // The server's schedule says which timers the agent still holds.
  const held = new Map(
    (session.scheduled?.timers ?? [])
      .filter((timer) => !sessionScheduledTimerEnded(timer))
      .map((timer) => [timer.id, timer]),
  );
  return panel.timers.map(({ task, runs, running }) => {
    const label = timerScheduleLabel(task, panel.timerSnapshotAt ?? "");
    const scheduled = held.get(task.id);
    // The run in progress is one of its runs: shown as that run.
    const current = running
      ? (runs.find(
          (run) => run.startedAt === running.startedAt && run.id === running.id,
        ) ?? running)
      : undefined;
    return {
      busy: panel.busy,
      detail: task.prompt.split(/\r?\n/)[0]?.slice(0, 120) || label,
      fires: runs,
      id: `${session.id}:timer:${task.id}`,
      kind: "timer" as const,
      label,
      ...(current ? { running: current } : {}),
      sessionId: session.id,
      task,
      ...(scheduled ? { scheduled } : {}),
      wake: wakes.get(task.id) ?? {},
      workspaceId: session.workspaceId,
    };
  });
}

/**
 * Each live timer's last wake and whether the thread's session holding the
 * schedule is busy, for when the chat's note says it wakes next; and the
 * timers' last ended run when it failed, which the note says too: a session
 * whose scheduled runs fail (its context full and compaction failing, say)
 * otherwise looks idle and healthy.
 */
export function threadScheduleWakes(sessions: readonly AgentSession[]): {
  busy: boolean;
  wakes: Map<string, ClaudeTimerWake>;
  failedRun?: ChatTimerFire;
} {
  const session = [...sessions].reverse().find((s) => s.scheduled);
  if (!session) return { busy: false, wakes: new Map() };
  const panel = sessionPanel(session);
  return {
    busy: panel?.busy ?? isSessionLive(session),
    wakes: panelWakes(panel),
    ...(panel?.failedTimerRun ? { failedRun: panel.failedTimerRun } : {}),
  };
}

/**
 * The error a failed run ended with means the context is full and the
 * agent could not compact it: the next run fails the same way until a
 * request compacts it, which another model can do.
 */
export function timerRunContextFull(fire: ChatTimerFire): boolean {
  return Boolean(
    fire.failed && /prompt is too long/i.test(fire.response ?? ""),
  );
}

/**
 * The schedule the server keeps for the thread's latest session that has
 * one, cut to its live timers: an expired one wakes nothing.
 */
export function liveThreadSchedule(
  sessions: readonly AgentSession[],
): AgentSessionSchedule | undefined {
  const scheduled = [...sessions].reverse().find((s) => s.scheduled)?.scheduled;
  const timers = (scheduled?.timers ?? []).filter(
    (timer) => !sessionScheduledTimerEnded(timer),
  );
  return scheduled && timers.length > 0 ? { ...scheduled, timers } : undefined;
}

/**
 * "1 scheduled task · next at 07:37": the chat is idle, yet timers its agent
 * holds will wake it. The time is when Claude Code fires the next one,
 * from what `wakes` say of each timer's last wake (threadScheduleWakes).
 * When the last run failed, the note says so ("… · last run failed").
 */
export function scheduledNote(
  schedule: AgentSessionSchedule,
  now: Date = new Date(),
  wakes: ReadonlyMap<string, ClaudeTimerWake> = new Map(),
  busy = false,
  failedRun?: ChatTimerFire,
): string {
  const note = nextWakeNote(schedule, now, wakes, busy);
  if (!failedRun) return note;
  return i18n.t(
    timerRunContextFull(failedRun)
      ? "chat:contextCard.scheduledNoteContextFull"
      : "chat:contextCard.scheduledNoteLastFailed",
    { note },
  );
}

function nextWakeNote(
  schedule: AgentSessionSchedule,
  now: Date,
  wakes: ReadonlyMap<string, ClaudeTimerWake>,
  busy: boolean,
): string {
  const count = schedule.timers.length;
  let next: { at?: Date; due: boolean } | undefined;
  for (const timer of schedule.timers) {
    if (sessionScheduledTimerEnded(timer, now)) continue;
    const run = timerNextRun(timer, wakes.get(timer.id) ?? {}, busy, now);
    if (run.at && (!next?.at || run.at.getTime() < next.at.getTime()))
      next = run;
  }
  if (!next?.at)
    return i18n.t("chat:contextCard.scheduledNoteNoTime", { count });
  if (next.due) return i18n.t("chat:contextCard.scheduledNoteDue", { count });
  return i18n.t("chat:contextCard.scheduledNote", {
    count,
    time: noteTime(next.at, now),
  });
}
