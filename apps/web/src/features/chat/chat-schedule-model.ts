import type {
  AgentSession,
  AgentSessionSchedule,
  AgentScheduledTask,
} from "@bd777/foundry-protocol";
import {
  claudeProcessStartedLabel,
  claudeTimerNextFire,
  humanizeCron,
  sessionInputEventLabel,
  sessionScheduledTimerExpired,
  type AgentSessionScheduledTimer,
  type ClaudeTimerWake,
} from "@bd777/foundry-protocol";
import type { ChatTimerFire, ChatTimerItem } from "./chat-types";
import { i18n } from "../../i18n";
import { responseStreamLabel } from "../../lib/agent-session-events";
import {
  isPanelOnlyEvent,
  latestBackgroundSnapshot,
  latestTimerSnapshot,
  withStateEvents,
} from "./chat-state-events";
import { noteTime } from "./chat-time";

/**
 * The schedule in the viewer's language, rebuilt from the cron expression
 * rather than the worker's stored (Chinese) humanSchedule. One-off times are
 * resolved from the snapshot's time, as the worker did when recording it.
 */
function timerScheduleLabel(task: AgentScheduledTask, snapshotAt: string) {
  const from = new Date(snapshotAt);
  return humanizeCron(
    task.schedule,
    task.recurring,
    Number.isNaN(from.getTime()) ? new Date() : from,
    i18n.language === "zh-CN" ? "zh-CN" : "en",
  );
}

interface SessionTimerRuns {
  /** Every timer's runs, newest first. */
  fires: ChatTimerFire[];
  /** The run Claude started on its own and has not ended, if any. */
  running?: ChatTimerFire;
  /** When a Claude process last started for the session. */
  resumedAt?: string;
}

/**
 * The session's timer runs. A run Claude starts on its own is published as
 * it fires and again with its answer, both under its start time; a run the
 * device sent is a session input, answered by that input's turn. A run
 * still open when a new input or process comes ended unanswered.
 */
function sessionTimerRuns(session: AgentSession): SessionTimerRuns {
  const fires: ChatTimerFire[] = [];
  const byStart = new Map<string, ChatTimerFire>();
  // Inputs' fires by input id, or by start time (a state event read for
  // the panel alone names no input).
  const byInput = new Map<string, ChatTimerFire>();
  let answering: ChatTimerFire | undefined;
  let running: ChatTimerFire | undefined;
  let resumedAt: string | undefined;
  for (const event of session.events ?? []) {
    // A state event read for the panel alone carries no message.
    const input = event.label === sessionInputEventLabel;
    // A new input ends what ran before it; a new process, a run of the
    // last one (the input it starts for is still answered).
    if (input) answering = undefined;
    if (input || event.label === claudeProcessStartedLabel) running = undefined;
    if (event.label === claudeProcessStartedLabel) resumedAt = event.at;
    const fire = event.metadata?.timerFire;
    if (fire) {
      const key =
        fire.origin === "scheduled" && fire.startedAt && !input
          ? `${fire.id ?? ""}|${fire.startedAt}`
          : undefined;
      const unloaded = isPanelOnlyEvent(event);
      const known = key ? byStart.get(key) : undefined;
      const record: ChatTimerFire = known ?? { ...fire };
      if (known) {
        Object.assign(record, fire);
        if (!unloaded) delete record.answerUnloaded;
      } else {
        if (unloaded) record.answerUnloaded = true;
        fires.push(record);
        if (key) byStart.set(key, record);
      }
      if (fire.completedAt && event.level === "error") record.failed = true;
      if (input)
        byInput.set(event.message?.id ?? record.startedAt ?? "", record);
      if (!record.completedAt) {
        if (input) answering = record;
        else running = record;
      } else if (running === record) running = undefined;
      continue;
    }
    if (!answering) continue;
    const isResponse = event.message
      ? event.message.kind === "assistant"
      : event.label === responseStreamLabel;
    if (isResponse) {
      const text = (event.message?.text ?? event.detail).trim();
      if (text) {
        answering.response = text;
        delete answering.answerUnloaded;
      }
    }
    if (event.metadata?.turnUsage) {
      answering.completedAt = event.at;
      answering = undefined;
    }
  }
  // The latest input's answer is the session's own, loaded or not.
  const latest =
    (session.input?.id ? byInput.get(session.input.id) : undefined) ??
    (session.input?.timerFire?.startedAt
      ? byInput.get(session.input.timerFire.startedAt)
      : undefined);
  if (
    latest &&
    (session.status === "completed" || session.status === "failed")
  ) {
    latest.completedAt ||= session.completedAt ?? "";
    if (session.status === "failed") latest.failed = true;
    if (!latest.response && session.response?.trim()) {
      latest.response = session.response.trim();
      delete latest.answerUnloaded;
    }
  }
  return { fires: fires.reverse(), running, resumedAt };
}

/** When a timer that fell due on an idle session counts as not yet run. */
const timerDueGraceMs = 2 * 60_000;

/**
 * When a timer runs next, as Claude Code will run it (claudeTimerNextFire):
 * `due` when its time passed while the session was busy, so it runs when
 * the current turn ends. A recurring time that passed while the session
 * was idle ran, in a run these events do not show (older workers published
 * none as it fired): its next time follows from now.
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

/**
 * What the session's events say of a timer's last wake: its last fire, or
 * the last start of a process that brought it back (one started before the
 * timer existed did not), whichever is later. Claude Code (2.1.291 and
 * later) brings a timer back as fired when it resumes the session.
 */
function timerWake(
  runs: SessionTimerRuns,
  id: string,
  firstSeenAt?: string,
): ClaudeTimerWake {
  // Newest first: the first is its last fire.
  const fired = runs.fires.find((fire) => fire.id === id && fire.startedAt);
  const created = firstSeenAt ? Date.parse(firstSeenAt) : Number.NaN;
  const resumed = runs.resumedAt ? Date.parse(runs.resumedAt) : Number.NaN;
  const times = [
    fired?.startedAt ? Date.parse(fired.startedAt) : Number.NaN,
    created >= resumed ? Number.NaN : resumed,
  ].filter(Number.isFinite);
  return times.length > 0 ? { firedAt: new Date(Math.max(...times)) } : {};
}

function sessionBusy(session: AgentSession, runs: SessionTimerRuns): boolean {
  return (
    session.status === "running" ||
    session.status === "queued" ||
    Boolean(runs.running) ||
    (latestBackgroundSnapshot(session) ?? []).some(
      (task) => task.status === "running",
    )
  );
}

export function projectSessionTimers(session: AgentSession): ChatTimerItem[] {
  const snapshot = latestTimerSnapshot(session);
  if (!snapshot || snapshot.tasks.length === 0) {
    return [];
  }
  const runs = sessionTimerRuns(session);
  const busy = sessionBusy(session, runs);
  // The server's schedule says which timers the agent still holds.
  const held = new Map(
    (session.scheduled?.timers ?? [])
      .filter((timer) => !sessionScheduledTimerExpired(timer))
      .map((timer) => [timer.id, timer]),
  );
  return snapshot.tasks.map((task) => {
    const label = timerScheduleLabel(task, snapshot.at);
    const scheduled = held.get(task.id);
    const running =
      runs.running && (!runs.running.id || runs.running.id === task.id)
        ? runs.running
        : undefined;
    return {
      busy,
      detail: task.prompt.split(/\r?\n/)[0]?.slice(0, 120) || label,
      fires: runs.fires.filter((fire) => fire.id === task.id),
      id: `${session.id}:timer:${task.id}`,
      kind: "timer" as const,
      label,
      ...(running ? { running } : {}),
      sessionId: session.id,
      task,
      ...(scheduled ? { scheduled } : {}),
      wake: timerWake(runs, task.id, scheduled?.firstSeenAt),
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
  const panel = withStateEvents(session);
  const runs = sessionTimerRuns(panel);
  const wakes = new Map<string, ClaudeTimerWake>();
  const timers = session.scheduled?.timers ?? [];
  for (const timer of timers)
    wakes.set(timer.id, timerWake(runs, timer.id, timer.firstSeenAt));
  const held = new Set(timers.map((timer) => timer.id));
  // Newest first: the first ended run of a timer the session holds.
  const lastRun = runs.fires.find(
    (fire) => fire.completedAt && (!fire.id || held.has(fire.id)),
  );
  return {
    busy: sessionBusy(panel, runs),
    wakes,
    ...(lastRun?.failed ? { failedRun: lastRun } : {}),
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
    (timer) => !sessionScheduledTimerExpired(timer),
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
    if (sessionScheduledTimerExpired(timer, now)) continue;
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
