/**
 * A session's timers outlive the agent process that holds them: Claude Code
 * brings its CronCreate jobs back when it resumes the session, but reports
 * them only as its hooks run, and it does not bring back a ScheduleWakeup
 * (dynamic /loop) wakeup. The device keeps each session's timers as the
 * last process holding them reported them, across worker restarts, and
 * hands them to the next process that runs the session (ClaudeTimerTracker's
 * `known`); timer-revival.ts delivers the ones that come due while no process
 * holds them, and the wakeups no process will fire.
 */

import { existsSync, readFileSync } from "node:fs";
import type { AgentScheduledTask } from "@bd777/foundry-protocol";
import { foundryStatePath } from "../../platform/state-root.js";
import { hardenPrivateFile, writeJSON } from "../../platform/storage.js";
import { errorMessage } from "../../platform/utils.js";

/** A timer's due time that fired: Claude ran it, or the device delivered it. */
export interface KeptTimerFire {
  /** The due time (ISO 8601). */
  dueAt: string;
  /** When it fired or was delivered. */
  at: string;
}

export interface KeptSession {
  sessionId: string;
  /** The native session the timers live in; resuming it brings them back. */
  nativeSessionId: string;
  timers: AgentScheduledTask[];
  /**
   * When a process of this worker last held the timers (it reported them,
   * or it ended): a recurring timer is due from then.
   */
  heldAt?: string;
  /**
   * ScheduleWakeup wakeups of a process that ended: no later process fires
   * them, the device delivers them when due.
   */
  wakeups?: AgentScheduledTask[];
  /** The last fire of each timer, by its id. */
  fired?: Record<string, KeptTimerFire>;
  /** When a process first reported each timer, by its id. */
  seen?: Record<string, string>;
}

/** A timer Claude Code does not bring back when it resumes the session. */
export function isWakeup(task: AgentScheduledTask): boolean {
  return task.createdBy === "ScheduleWakeup";
}

export class SessionTimers {
  private readonly sessions = new Map<string, KeptSession>();
  /** The processes of this worker running each session: they hold its timers. */
  private readonly holders = new Map<string, Set<object>>();
  private readonly listeners = new Set<() => void>();

  /** `path` keeps the timers across restarts; in memory only without. */
  constructor(
    private path?: string,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Keeps the timers in `path`, reading the ones kept before. */
  load(path: string): void {
    this.path = path;
    if (!existsSync(path)) return;
    hardenPrivateFile(path);
    let stored: { sessions?: KeptSession[] } = {};
    try {
      stored = JSON.parse(readFileSync(path, "utf8")) as typeof stored;
    } catch (error) {
      console.error(
        `Could not read the kept session timers: ${errorMessage(error)}`,
      );
      return;
    }
    for (const session of stored.sessions ?? []) {
      if (!session?.sessionId || !Array.isArray(session.timers)) continue;
      this.sessions.set(session.sessionId, session);
    }
    this.changed();
  }

  /** Called whenever the kept timers or their holders change. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every session with timers kept, as copies. */
  kept(): KeptSession[] {
    return [...this.sessions.values()].map((session) => ({
      ...session,
      timers: [...session.timers],
      ...(session.wakeups ? { wakeups: [...session.wakeups] } : {}),
      ...(session.fired ? { fired: { ...session.fired } } : {}),
    }));
  }

  /**
   * The wake-ups of an earlier process the device still delivers for the
   * session: no Claude process brings them back.
   */
  owedWakeups(sessionId: string): AgentScheduledTask[] {
    return [...(this.sessions.get(sessionId)?.wakeups ?? [])];
  }

  /** Whether a process of this worker runs the session now. */
  held(sessionId: string): boolean {
    return (this.holders.get(sessionId)?.size ?? 0) > 0;
  }

  /**
   * `holder`, a process of this worker, runs the session; it holds the timers it
   * resumes. Returns the session's kept timers when they live in that
   * native session. Wake-ups of an earlier process stay the device's to
   * deliver: Claude Code does not bring them back.
   */
  attach(
    sessionId: string,
    nativeSessionId: string,
    holder: object,
  ): AgentScheduledTask[] {
    const holders = this.holders.get(sessionId) ?? new Set<object>();
    const first = holders.size === 0;
    holders.add(holder);
    this.holders.set(sessionId, holders);
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
      this.changed();
      return [];
    }
    if (first) {
      const orphaned = kept.timers.filter(isWakeup);
      if (orphaned.length > 0) {
        kept.wakeups = mergeTimers(kept.wakeups ?? [], orphaned);
        kept.timers = kept.timers.filter((task) => !isWakeup(task));
        this.save();
      }
    }
    this.changed();
    return [...kept.timers];
  }

  /** The session's timers as the process holding them reports them. */
  record(
    sessionId: string,
    nativeSessionId: string,
    tasks: readonly AgentScheduledTask[],
  ): void {
    if (!sessionId) return;
    const previous = this.sessions.get(sessionId);
    if (tasks.length === 0 && !previous?.wakeups?.length) {
      if (this.sessions.delete(sessionId)) {
        this.save();
        this.changed();
      }
      return;
    }
    const now = new Date(this.clock()).toISOString();
    const seen: Record<string, string> = {};
    for (const task of [...tasks, ...(previous?.wakeups ?? [])])
      seen[task.id] = previous?.seen?.[task.id] ?? now;
    this.sessions.set(sessionId, {
      ...previous,
      sessionId,
      nativeSessionId: nativeSessionId || previous?.nativeSessionId || "",
      timers: [...tasks],
      heldAt: now,
      seen,
    });
    this.save();
    this.changed();
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
    else {
      const kept = this.sessions.get(sessionId);
      if (kept) {
        kept.heldAt = new Date(this.clock()).toISOString();
        this.save();
      }
      this.changed();
    }
  }

  /**
   * The timer's due time fired: Claude ran it, or the device delivered it.
   * A one-time timer is done with it.
   */
  markFired(sessionId: string, task: AgentScheduledTask, dueAt: string): void {
    const kept = this.sessions.get(sessionId);
    if (!kept) return;
    kept.fired = {
      ...kept.fired,
      [task.id]: { dueAt, at: new Date(this.clock()).toISOString() },
    };
    if (!task.recurring) {
      kept.timers = kept.timers.filter((entry) => entry.id !== task.id);
      kept.wakeups = kept.wakeups?.filter((entry) => entry.id !== task.id);
    }
    if (kept.timers.length === 0 && !kept.wakeups?.length)
      this.sessions.delete(sessionId);
    this.save();
    this.changed();
  }

  /** The session ended for good (archived, gone): nothing is delivered. */
  forget(sessionId: string): void {
    if (!this.sessions.delete(sessionId)) return;
    this.save();
    this.changed();
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error(`Session timer listener failed: ${errorMessage(error)}`);
      }
    }
  }

  private save(): void {
    if (!this.path) return;
    try {
      writeJSON(this.path, { sessions: [...this.sessions.values()] });
    } catch (error) {
      console.error(
        `Could not keep the session timers: ${errorMessage(error)}`,
      );
    }
  }
}

function mergeTimers(
  kept: readonly AgentScheduledTask[],
  added: readonly AgentScheduledTask[],
): AgentScheduledTask[] {
  const byId = new Map(kept.map((task) => [task.id, task]));
  for (const task of added) byId.set(task.id, task);
  return [...byId.values()];
}

/** This worker's kept timers. */
export const sessionTimers = new SessionTimers();

/** Keeps this worker's session timers across restarts. */
export function keepSessionTimers(): void {
  sessionTimers.load(foundryStatePath("session-timers.json"));
}
