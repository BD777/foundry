/**
 * A session's timers outlive the agent process that holds them: Claude Code
 * brings them back when it resumes the session. While no process runs the
 * session (the worker restarted, or its process ended or was stopped)
 * nothing fires them, so the device keeps every session's timers and, when
 * one is due then, has the server send the timer's prompt as the session's
 * next input. That turn resumes the session; Claude Code holds the timers
 * again, each one's last fire set to that moment (it never fires the same
 * time twice), and fires them itself from then on. A timer is sent by the
 * device only while no process of its own holds it, so it never fires
 * twice.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  claudeOneShotFireAt,
  claudeRecurringFireAfter,
  claudeRecurringTimerMaxAgeMs,
  type AgentScheduledTask,
} from "@bd777/foundry-protocol";
import { foundryStatePath } from "./state-root.js";
import { hardenPrivateFile, writeJSON } from "./storage.js";
import { daemonRequestHeaders } from "./transport.js";

/** A timer the device keeps for a session. */
export interface KeptTimer extends AgentScheduledTask {
  /** When the device first saw it: recurring timers end a week later. */
  firstSeenAt: string;
  /** The fire time the device last sent it for. */
  firedAt?: string;
}

interface KeptSession {
  sessionId: string;
  /** The native session the timers live in; resuming it brings them back. */
  nativeSessionId: string;
  timers: KeptTimer[];
  /** When the last process holding them ended (or the device restarted). */
  endedAt?: string;
}

/** A due timer for the server to send as the session's next input. */
export interface TimerFireRequest {
  sessionId: string;
  nativeSessionId: string;
  timerId: string;
  prompt: string;
  /** The fire time it is sent for (ISO 8601). */
  dueAt: string;
}

/**
 * sent: the session took the prompt. busy: it is answering another input;
 * try again. gone: the session was deleted, or no longer runs these timers'
 * native session here; forget them. retry: the server could not say.
 */
export type TimerFireOutcome = "sent" | "busy" | "gone" | "retry";

interface SessionTimersOptions {
  /** Where the timers are kept across restarts; in memory only without. */
  path?: string;
  /** Sends a due timer; without it nothing is sent. */
  send?: (request: TimerFireRequest) => Promise<TimerFireOutcome>;
  now?: () => Date;
  /**
   * After a timer is sent, how long its session's other timers wait for
   * the process the sent prompt starts.
   */
  resumeWaitMs?: number;
}

const defaultResumeWaitMs = 10 * 60_000;

export class SessionTimers {
  private readonly sessions = new Map<string, KeptSession>();
  /** The processes of this worker running each session: they hold its timers. */
  private readonly holders = new Map<string, Set<object>>();
  /** Sessions sent a timer, until a process runs them (ms). */
  private readonly resuming = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(private options: SessionTimersOptions = {}) {}

  configure(options: SessionTimersOptions): void {
    this.options = { ...this.options, ...options };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /**
   * Reads the timers kept before this worker started. No process of this
   * worker runs their sessions yet: they are due from now on (Claude Code
   * skips times missed while nothing ran too).
   */
  load(): void {
    const path = this.options.path;
    if (!path || !existsSync(path)) return;
    hardenPrivateFile(path);
    let stored: { sessions?: KeptSession[] } = {};
    try {
      stored = JSON.parse(readFileSync(path, "utf8")) as typeof stored;
    } catch (error) {
      console.error(
        `Could not read the kept session timers: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const endedAt = this.now().toISOString();
    for (const session of stored.sessions ?? []) {
      if (!session?.sessionId || !Array.isArray(session.timers)) continue;
      this.sessions.set(session.sessionId, {
        ...session,
        endedAt: this.live(session.sessionId) ? undefined : endedAt,
      });
    }
  }

  private live(sessionId: string): boolean {
    return (this.holders.get(sessionId)?.size ?? 0) > 0;
  }

  /**
   * `holder`, a process of this worker, runs the session; it holds the timers it
   * resumes. Returns the session's kept timers when they live in that
   * native session.
   */
  attach(
    sessionId: string,
    nativeSessionId: string,
    holder: object,
  ): AgentScheduledTask[] {
    const holders = this.holders.get(sessionId) ?? new Set<object>();
    holders.add(holder);
    this.holders.set(sessionId, holders);
    this.resuming.delete(sessionId);
    // One native session's timers belong to one Foundry session.
    for (const [id, kept] of this.sessions) {
      if (
        id !== sessionId &&
        nativeSessionId &&
        kept.nativeSessionId === nativeSessionId
      ) {
        this.sessions.delete(id);
        this.save();
      }
    }
    const kept = this.sessions.get(sessionId);
    if (!kept) return [];
    if (nativeSessionId && kept.nativeSessionId !== nativeSessionId) {
      // A new native session does not bring the old one's timers back.
      this.sessions.delete(sessionId);
      this.save();
      return [];
    }
    if (kept.endedAt) {
      kept.endedAt = undefined;
      this.save();
    }
    return kept.timers.map(
      ({ firstSeenAt: _first, firedAt: _fired, ...task }) => task,
    );
  }

  /** The session's timers as the process holding them reports them. */
  record(
    sessionId: string,
    nativeSessionId: string,
    tasks: readonly AgentScheduledTask[],
  ): void {
    if (!sessionId) return;
    if (tasks.length === 0) {
      if (this.sessions.delete(sessionId)) this.save();
      return;
    }
    const previous = this.sessions.get(sessionId);
    const known = new Map(previous?.timers.map((timer) => [timer.id, timer]));
    const now = this.now().toISOString();
    this.sessions.set(sessionId, {
      sessionId,
      nativeSessionId: nativeSessionId || previous?.nativeSessionId || "",
      endedAt: this.live(sessionId) ? undefined : previous?.endedAt,
      timers: tasks.map((task) => ({
        ...task,
        firstSeenAt: known.get(task.id)?.firstSeenAt ?? now,
        ...(known.get(task.id)?.firedAt
          ? { firedAt: known.get(task.id)?.firedAt }
          : {}),
      })),
    });
    this.save();
  }

  /**
   * `holder`, which ran the session, ended (or runs another one); it held
   * these timers. They wait for the next process once no other runs it.
   */
  detach(
    sessionId: string,
    nativeSessionId: string,
    tasks: readonly AgentScheduledTask[],
    holder: object,
  ): void {
    const holders = this.holders.get(sessionId);
    if (!holders?.delete(holder)) return;
    if (holders.size > 0) return;
    this.holders.delete(sessionId);
    if (tasks.length > 0) this.record(sessionId, nativeSessionId, tasks);
    const kept = this.sessions.get(sessionId);
    if (!kept) return;
    kept.endedAt = this.now().toISOString();
    this.save();
  }

  /** The session's timers, as kept (for tests and diagnostics). */
  kept(sessionId: string): readonly KeptTimer[] | undefined {
    return this.sessions.get(sessionId)?.timers;
  }

  /**
   * The timers due now in sessions no process runs, one per session, in
   * the order they fell due. Expired ones are dropped.
   */
  due(): Array<{ session: KeptSession; timer: KeptTimer; dueAt: Date }> {
    const now = this.now();
    const result: Array<{
      session: KeptSession;
      timer: KeptTimer;
      dueAt: Date;
    }> = [];
    for (const session of this.sessions.values()) {
      if (this.live(session.sessionId) || !session.endedAt) continue;
      const resumingSince = this.resuming.get(session.sessionId);
      if (
        resumingSince !== undefined &&
        now.getTime() - resumingSince <
          (this.options.resumeWaitMs ?? defaultResumeWaitMs)
      )
        continue;
      let earliest: { timer: KeptTimer; dueAt: Date } | undefined;
      const timers = session.timers.filter(
        (timer) =>
          !timer.recurring ||
          now.getTime() - Date.parse(timer.firstSeenAt) <
            claudeRecurringTimerMaxAgeMs,
      );
      if (timers.length !== session.timers.length) {
        session.timers = timers;
        this.save();
      }
      for (const timer of timers) {
        const dueAt = timerDueAt(timer, session.endedAt);
        if (!dueAt || dueAt.getTime() > now.getTime()) continue;
        if (!earliest || dueAt.getTime() < earliest.dueAt.getTime())
          earliest = { timer, dueAt };
      }
      if (earliest) result.push({ session, ...earliest });
    }
    for (const session of [...this.sessions.values()]) {
      if (session.timers.length === 0) this.sessions.delete(session.sessionId);
    }
    return result.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  }

  /** Sends what is due. */
  async tick(): Promise<void> {
    const send = this.options.send;
    if (!send || this.ticking) return;
    this.ticking = true;
    try {
      for (const { session, timer, dueAt } of this.due()) {
        let outcome: TimerFireOutcome;
        try {
          outcome = await send({
            sessionId: session.sessionId,
            nativeSessionId: session.nativeSessionId,
            timerId: timer.id,
            prompt: timer.prompt,
            dueAt: dueAt.toISOString(),
          });
        } catch (error) {
          console.error(
            `Could not send timer ${timer.id} of session ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          outcome = "retry";
        }
        if (outcome === "gone") {
          this.sessions.delete(session.sessionId);
          this.save();
        } else if (outcome === "sent") {
          this.resuming.set(session.sessionId, this.now().getTime());
          if (timer.recurring) timer.firedAt = dueAt.toISOString();
          else
            session.timers = session.timers.filter(
              (kept) => kept.id !== timer.id,
            );
          this.save();
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  start(intervalMs = 30_000): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private save(): void {
    const path = this.options.path;
    if (!path) return;
    try {
      writeJSON(path, { sessions: [...this.sessions.values()] });
    } catch (error) {
      console.error(
        `Could not keep the session timers: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * When a kept timer is due while no process holds it: a recurring one at
 * its first time (offset included, as Claude Code fires it) after the
 * process ended or it was last sent; a one-shot one at its time, or at once
 * when that passed while nothing ran.
 */
export function timerDueAt(
  timer: KeptTimer,
  endedAt: string,
): Date | undefined {
  if (!timer.recurring)
    return claudeOneShotFireAt(
      timer.schedule,
      timer.id,
      new Date(timer.firstSeenAt),
    );
  const since = Math.max(
    Date.parse(endedAt),
    timer.firedAt ? Date.parse(timer.firedAt) : 0,
  );
  return Number.isFinite(since)
    ? claudeRecurringFireAfter(timer.schedule, timer.id, new Date(since))
    : undefined;
}

/** This worker's kept timers; the daemon gives them a file and a server. */
export const sessionTimers = new SessionTimers();

/**
 * Keeps this worker's session timers across restarts and has the server
 * send the ones due while no process runs their session.
 */
export function startSessionTimers(serverURL: string): void {
  sessionTimers.configure({
    path: foundryStatePath("session-timers.json"),
    send: (request) => sendTimerFire(serverURL, request),
  });
  sessionTimers.load();
  sessionTimers.start();
}

async function sendTimerFire(
  serverURL: string,
  request: TimerFireRequest,
): Promise<TimerFireOutcome> {
  const response = await fetch(
    `${serverURL}/api/daemon/sessions/${encodeURIComponent(request.sessionId)}/timer-fires`,
    {
      method: "POST",
      headers: daemonRequestHeaders(true),
      body: JSON.stringify({
        timerId: request.timerId,
        prompt: request.prompt,
        dueAt: request.dueAt,
        nativeSessionId: request.nativeSessionId,
      }),
    },
  );
  if (response.ok) {
    console.log(
      `Sent timer ${request.timerId} of session ${request.sessionId} (due ${request.dueAt}) to resume it`,
    );
    return "sent";
  }
  if (response.status === 404 || response.status === 410) return "gone";
  if (response.status === 409) {
    const body = (await response.json().catch(() => ({}))) as {
      code?: string;
    };
    // A refusal the session will not outgrow (another device's, another
    // provider's): its timers are not this device's to send.
    return body.code === "session_busy" ? "busy" : "gone";
  }
  return "retry";
}
