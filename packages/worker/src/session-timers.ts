/**
 * A session's timers outlive the agent process that holds them: Claude Code
 * brings them back when it resumes the session, but reports them only as
 * its hooks run. The device keeps each session's timers as the last process
 * holding them reported them, across worker restarts, and hands them to the
 * next process that runs the session (ClaudeTimerTracker's `known`).
 */

import { existsSync, readFileSync } from "node:fs";
import type { AgentScheduledTask } from "@bd777/foundry-protocol";
import { foundryStatePath } from "./state-root.js";
import { hardenPrivateFile, writeJSON } from "./storage.js";
import { errorMessage } from "./utils.js";

interface KeptSession {
  sessionId: string;
  /** The native session the timers live in; resuming it brings them back. */
  nativeSessionId: string;
  timers: AgentScheduledTask[];
}

export class SessionTimers {
  private readonly sessions = new Map<string, KeptSession>();
  /** The processes of this worker running each session: they hold its timers. */
  private readonly holders = new Map<string, Set<object>>();

  /** `path` keeps the timers across restarts; in memory only without. */
  constructor(private path?: string) {}

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
    return [...kept.timers];
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
    this.sessions.set(sessionId, {
      sessionId,
      nativeSessionId: nativeSessionId || previous?.nativeSessionId || "",
      timers: [...tasks],
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

/** This worker's kept timers. */
export const sessionTimers = new SessionTimers();

/** Keeps this worker's session timers across restarts. */
export function keepSessionTimers(): void {
  sessionTimers.load(foundryStatePath("session-timers.json"));
}
