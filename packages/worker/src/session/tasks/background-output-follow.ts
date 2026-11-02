/**
 * Background task logs someone is reading while they grow.
 *
 * A read that asks to follow a running task's log starts or renews a short
 * lease. While it lasts the log's size is checked every couple of seconds
 * and a change is told once per check, so the reader reads what was added
 * instead of asking again on a timer, and a busy log costs at most one read
 * per check. A lease ends unless reads renew it, when the task stops
 * running (after telling a last change) and when the connection closes.
 */

import { statSync } from "node:fs";

/** A task's log as the device knows it now. */
export interface FollowedLog {
  /** Undefined while the task has written no log. */
  path?: string;
  running: boolean;
}

export interface BackgroundOutputFollowOptions {
  /** Tells the server that a followed task's log changed. */
  notify: (sessionId: string, taskId: string) => void;
  leaseMs?: number;
  checkEveryMs?: number;
  /** Logs followed at once; a read beyond it is not followed. */
  limit?: number;
  now?: () => number;
}

interface Follower {
  sessionId: string;
  taskId: string;
  locate: () => FollowedLog;
  bytes: number;
  expiresAt: number;
}

export const backgroundOutputLeaseMs = 60_000;
/** How often followed logs are checked: the most often a change is told. */
export const backgroundOutputCheckMs = 2_000;

function logSize(path: string | undefined): number {
  if (!path) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export class BackgroundOutputFollowers {
  private readonly followers = new Map<string, Follower>();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly options: BackgroundOutputFollowOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * Follows a task's log for a reader that holds `bytes` of it. Returns
   * whether it is followed: not when the task no longer runs, the
   * connection closed or too many logs are followed.
   */
  follow(
    sessionId: string,
    taskId: string,
    bytes: number,
    locate: () => FollowedLog,
  ): boolean {
    if (this.closed || !locate().running) return false;
    const key = `${sessionId}\n${taskId}`;
    if (
      !this.followers.has(key) &&
      this.followers.size >= (this.options.limit ?? 16)
    )
      return false;
    this.followers.set(key, {
      sessionId,
      taskId,
      locate,
      bytes,
      expiresAt: this.now() + (this.options.leaseMs ?? backgroundOutputLeaseMs),
    });
    if (!this.timer) {
      this.timer = setInterval(
        () => this.check(),
        this.options.checkEveryMs ?? backgroundOutputCheckMs,
      );
      this.timer.unref();
    }
    return true;
  }

  /** Checks every followed log once; the timer calls it. */
  check(): void {
    const now = this.now();
    for (const [key, follower] of this.followers) {
      if (now >= follower.expiresAt) {
        this.followers.delete(key);
        continue;
      }
      let log: FollowedLog;
      try {
        log = follower.locate();
      } catch {
        log = { running: false };
      }
      const bytes = logSize(log.path);
      if (bytes !== follower.bytes) {
        follower.bytes = bytes;
        this.options.notify(follower.sessionId, follower.taskId);
      }
      if (!log.running) this.followers.delete(key);
    }
    if (this.followers.size === 0) this.stopTimer();
  }

  get size(): number {
    return this.followers.size;
  }

  close(): void {
    this.closed = true;
    this.followers.clear();
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
