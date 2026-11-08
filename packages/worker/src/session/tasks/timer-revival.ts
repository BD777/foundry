/**
 * Claude timers across worker restarts. Claude Code fires a session's timers
 * only while a process holds the session: a CronCreate job comes back when
 * the session resumes (Claude Code resurrects it, counting it as just fired,
 * and drops a one-time job whose time passed), a ScheduleWakeup (dynamic
 * /loop) wakeup does not. So the device:
 *
 * - leaves a timer to Claude while a process of this worker holds the
 *   session, except a wakeup of an earlier process, which nothing else fires;
 * - delivers a timer that comes due while no process holds the session as
 *   the session's next input, through the server (the session's ordinary
 *   resume path), marked as the timer's fire. The process that resumes for
 *   it brings the session's crons back counted as fired, so the native
 *   scheduler does not fire the same time again;
 * - delivers a timer whose time passed while nothing ran (the worker was
 *   down) once, marked as a catch-up, however many times it was missed.
 *
 * A due time is delivered once: the device marks it (session-timers.ts) and
 * the server names its input after the timer and due time, so a repeated
 * request records nothing new.
 */

import {
  claudeOneShotFireAt,
  claudeTimerNextFire,
  type AgentScheduledTask,
} from "@bd777/foundry-protocol";
import { postJSON } from "../../transport/server-http.js";
import { errorMessage } from "../../platform/utils.js";
import {
  isWakeup,
  sessionTimers,
  type KeptSession,
  type SessionTimers,
} from "./session-timers.js";

/** What the device does about one kept timer now. */
export type TimerRevivalDecision =
  /** A live process fires it (Claude Code holds it). */
  | { action: "native" }
  /** Its next due time is ahead. */
  | { action: "wait"; at: number }
  /** Deliver it now. */
  | { action: "fire"; dueAt: string; catchUp: boolean }
  /** Its due time was delivered or fired already, or it has none. */
  | { action: "done" };

export interface TimerRevivalInput {
  task: AgentScheduledTask;
  /** A process of this worker runs the session. */
  held: boolean;
  /** A wakeup whose process ended: no process will fire it. */
  orphan: boolean;
  /** When a process last held the timers. */
  heldAt?: string;
  /** Its last fire, Claude's or the device's. */
  fired?: { dueAt: string; at: string };
  /** When a process first reported it. */
  seenAt?: string;
  /** When this worker started delivering timers. */
  startedAt: number;
  now: number;
}

/** Claude Code's age limit of a recurring timer (recurringMaxAgeMs). */
export const claudeTimerMaxAgeMs = 7 * 24 * 60 * 60_000;

function time(value: string | undefined): number | undefined {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * When the timer is next due after `from`: a wakeup at the exact time Claude
 * scheduled it for, another one-time timer at its schedule's first time
 * after it was made (`seenAt`), a recurring one at the next time Claude Code
 * would fire it.
 */
export function timerDueAfter(
  task: AgentScheduledTask,
  from: number,
  seenAt: number = from,
): number | undefined {
  if (!task.recurring) {
    const exact = isWakeup(task) ? time(task.nextFireAt) : undefined;
    return (
      exact ??
      claudeOneShotFireAt(task.schedule, task.id, new Date(seenAt))?.getTime()
    );
  }
  return claudeTimerNextFire(task, new Date(from), {
    firedAt: new Date(from),
  })?.getTime();
}

/** The decision for one kept timer (pure; timer-revival.test.mjs). */
export function planTimerRevival(
  input: TimerRevivalInput,
): TimerRevivalDecision {
  const { task, held, orphan, startedAt, now } = input;
  if (held && !orphan) return { action: "native" };
  const heldAt = time(input.heldAt) ?? startedAt;
  // Claude Code ends a recurring timer a week after it was made, and a
  // timer missed for longer than that is not caught up.
  const seenAt = time(input.seenAt) ?? heldAt;
  if (task.recurring && now - seenAt >= claudeTimerMaxAgeMs)
    return { action: "done" };
  const firedAt = time(input.fired?.at);
  // A recurring timer is due from its last fire, or from when a process
  // last held it; a one-time timer once.
  const from = Math.max(heldAt, firedAt ?? 0);
  const due = timerDueAfter(task, from, seenAt);
  if (due === undefined) return { action: "done" };
  const dueAt = new Date(due).toISOString();
  if (input.fired && (time(input.fired.dueAt) === due || !task.recurring))
    return { action: "done" };
  if (due > now) return { action: "wait", at: due };
  if (now - due >= claudeTimerMaxAgeMs) return { action: "done" };
  // Late when its time passed before anything here could deliver it: this
  // worker started after it, or no process held it since before it.
  return { action: "fire", dueAt, catchUp: due < Math.max(startedAt, heldAt) };
}

/** Every kept timer's decision, by session. */
export function planKeptTimers(
  session: KeptSession,
  held: boolean,
  startedAt: number,
  now: number,
): Array<{ task: AgentScheduledTask; decision: TimerRevivalDecision }> {
  const wakeups = session.wakeups ?? [];
  const tasks: Array<{ task: AgentScheduledTask; orphan: boolean }> = [
    ...session.timers.map((task) => ({
      task,
      // A process holding the session reported it, or none holds it now.
      orphan: !held && isWakeup(task),
    })),
    ...wakeups
      .filter((task) => !session.timers.some((entry) => entry.id === task.id))
      .map((task) => ({ task, orphan: true })),
  ];
  return tasks.map(({ task, orphan }) => ({
    task,
    decision: planTimerRevival({
      task,
      held,
      orphan,
      heldAt: session.heldAt,
      fired: session.fired?.[task.id],
      seenAt: session.seen?.[task.id],
      startedAt,
      now,
    }),
  }));
}

/** The server's answer to a delivered timer. */
export type TimerDelivery = "delivered" | "busy" | "gone";

export interface TimerFireRequest {
  timerId: string;
  prompt: string;
  dueAt: string;
  catchUp: boolean;
}

/**
 * A late timer's prompt says it is late: the agent decides whether what it
 * scheduled still applies.
 */
export function catchUpPrompt(prompt: string, dueAt: string): string {
  return `[Foundry: this scheduled prompt was due at ${dueAt} but no Claude process held the session then (its device was down or restarting). It is delivered once now, late; earlier missed times are not repeated. Check that it still applies before acting on it.]\n\n${prompt}`;
}

const retryMs = 30_000;
/** Plans are checked again at least this often (a clock that jumped). */
const recheckMs = 10 * 60_000;

/** Delivers a session's due timers through the server. */
export class TimerRevival {
  private timer?: ReturnType<typeof setTimeout>;
  private armedAt = 0;
  private paused = false;
  private stopped = true;
  private unsubscribe?: () => void;
  private readonly inFlight = new Set<string>();
  /** Sessions the server refused just now (busy, offline), until when. */
  private readonly retryAt = new Map<string, number>();
  private readonly startedAt: number;

  constructor(
    private readonly timers: SessionTimers,
    private readonly deliver: (
      sessionId: string,
      fire: TimerFireRequest,
    ) => Promise<TimerDelivery>,
    private readonly clock: () => number = Date.now,
    private readonly log: (line: string) => void = (line) =>
      console.error(`${new Date().toISOString()} [timer-revival] ${line}`),
  ) {
    this.startedAt = clock();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsubscribe = this.timers.onChange(() => this.schedule(0));
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** A runner handing over to the next one delivers nothing meanwhile. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) this.schedule(0);
  }

  /** Runs one pass now: delivers what is due, then waits for the next. */
  async sweep(): Promise<void> {
    if (this.paused) return;
    const now = this.clock();
    let next = now + recheckMs;
    const fires: Promise<void>[] = [];
    for (const session of this.timers.kept()) {
      const retry = this.retryAt.get(session.sessionId) ?? 0;
      const held = this.timers.held(session.sessionId);
      for (const { task, decision } of planKeptTimers(
        session,
        held,
        this.startedAt,
        now,
      )) {
        if (decision.action === "wait") next = Math.min(next, decision.at);
        if (decision.action !== "fire") continue;
        if (retry > now) {
          next = Math.min(next, retry);
          continue;
        }
        const key = `${session.sessionId}\u0000${task.id}`;
        if (this.inFlight.has(key)) continue;
        this.inFlight.add(key);
        fires.push(
          this.fire(session.sessionId, task, decision).finally(() =>
            this.inFlight.delete(key),
          ),
        );
      }
    }
    this.arm(next - this.clock());
    await Promise.all(fires);
  }

  private async fire(
    sessionId: string,
    task: AgentScheduledTask,
    decision: { dueAt: string; catchUp: boolean },
  ): Promise<void> {
    let outcome: TimerDelivery;
    try {
      outcome = await this.deliver(sessionId, {
        timerId: task.id,
        prompt: decision.catchUp
          ? catchUpPrompt(task.prompt, decision.dueAt)
          : task.prompt,
        dueAt: decision.dueAt,
        catchUp: decision.catchUp,
      });
    } catch (error) {
      this.log(
        `session=${sessionId} timer=${task.id} due=${decision.dueAt}: ${errorMessage(error)}; retrying`,
      );
      outcome = "busy";
    }
    if (outcome === "busy") {
      this.retryAt.set(sessionId, this.clock() + retryMs);
      this.schedule(retryMs);
      return;
    }
    this.retryAt.delete(sessionId);
    this.log(
      `session=${sessionId} timer=${task.id} due=${decision.dueAt} ${outcome === "gone" ? "dropped: the session is gone" : decision.catchUp ? "delivered as a catch-up" : "delivered"}`,
    );
    if (outcome === "gone") this.timers.forget(sessionId);
    else this.timers.markFired(sessionId, task, decision.dueAt);
  }

  private schedule(delay: number): void {
    this.arm(delay);
  }

  /** The next sweep within `delay` ms, unless one comes sooner. */
  private arm(delay: number): void {
    if (this.stopped) return;
    const wait = Math.min(Math.max(delay, 0), recheckMs);
    const at = this.clock() + wait;
    if (this.timer && this.armedAt <= at) return;
    clearTimeout(this.timer);
    this.armedAt = at;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.sweep().catch((error) =>
        this.log(`sweep failed: ${errorMessage(error)}`),
      );
    }, wait);
    this.timer.unref?.();
  }
}

/** Asks the server to deliver a due timer to the session. */
export async function deliverTimerFire(
  serverURL: string,
  sessionId: string,
  fire: TimerFireRequest,
): Promise<TimerDelivery> {
  try {
    await postJSON(
      serverURL,
      `/api/daemon/sessions/${encodeURIComponent(sessionId)}/timer-fire`,
      fire,
    );
    return "delivered";
  } catch (error) {
    const status = /returned (\d{3})/.exec(errorMessage(error))?.[1];
    if (status === "404" || status === "400") return "gone";
    // An archived session refuses with session_archived.
    if (status === "409" && /session_archived/.test(errorMessage(error)))
      return "gone";
    if (status === "409") return "busy";
    throw error;
  }
}

let revival: TimerRevival | undefined;

/** Starts delivering this worker's due timers (where its sessions run). */
export function startTimerRevival(serverURL: string): void {
  revival?.stop();
  revival = new TimerRevival(sessionTimers, (sessionId, fire) =>
    deliverTimerFire(serverURL, sessionId, fire),
  );
  revival.start();
}

/** A runner draining for a switch delivers no timer until it resumes. */
export function setTimerRevivalPaused(paused: boolean): void {
  revival?.setPaused(paused);
}
