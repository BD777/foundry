/**
 * Concurrent task scheduler with per-key serialization and idle waiting.
 */

/** Why a scheduled task did not start at once. */
export interface SchedulerWait {
  /** Tasks running now. */
  running: number;
  /** How many may run at once. */
  limit: number;
  /** A task with the same key runs: this one follows it, whatever the limit. */
  sameKey: boolean;
}

type ScheduledTask = {
  key: string;
  reject: (error: unknown) => void;
  resolve: (value: unknown) => void;
  run: () => Promise<unknown> | unknown;
};

export function normalizeMaxConcurrentTasks(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return 4;
  }
  return Math.min(16, Math.max(1, Math.round(value)));
}

export class ConcurrentTaskScheduler {
  private active = 0;
  private activeKeys = new Set<string>();
  private idleWaiters: Array<() => void> = [];
  private maxConcurrentTasks: number;
  private queued: ScheduledTask[] = [];

  constructor(maxConcurrentTasks: number) {
    this.maxConcurrentTasks = normalizeMaxConcurrentTasks(maxConcurrentTasks);
  }

  /** Runs the task when there is room; onWait hears at once if there is none. */
  schedule<T>(
    key: string,
    run: () => Promise<T> | T,
    onWait?: (wait: SchedulerWait) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: ScheduledTask = {
        key: key.trim() || `task_${this.queued.length}`,
        reject,
        resolve: (value) => resolve(value as T),
        run,
      };
      this.queued.push(task);
      this.drain();
      if (onWait && this.queued.includes(task))
        onWait({
          running: this.active,
          limit: this.maxConcurrentTasks,
          sameKey: this.activeKeys.has(task.key),
        });
    });
  }

  /** Tasks running now and how many may. */
  load(): { running: number; limit: number } {
    return { running: this.active, limit: this.maxConcurrentTasks };
  }

  setMaxConcurrentTasks(maxConcurrentTasks: number): void {
    this.maxConcurrentTasks = normalizeMaxConcurrentTasks(maxConcurrentTasks);
    this.drain();
  }

  whenIdle(): Promise<void> {
    if (this.active === 0 && this.queued.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolveIdle) => {
      this.idleWaiters.push(resolveIdle);
    });
  }

  private drain(): void {
    while (this.active < this.maxConcurrentTasks) {
      const nextIndex = this.queued.findIndex(
        (task) => !this.activeKeys.has(task.key),
      );
      if (nextIndex < 0) {
        break;
      }
      const [task] = this.queued.splice(nextIndex, 1);
      if (!task) {
        break;
      }
      this.active += 1;
      this.activeKeys.add(task.key);
      void Promise.resolve()
        .then(task.run)
        .then(task.resolve, task.reject)
        .finally(() => {
          this.active -= 1;
          this.activeKeys.delete(task.key);
          this.drain();
          this.resolveIdleWaiters();
        });
    }
  }

  private resolveIdleWaiters(): void {
    if (this.active !== 0 || this.queued.length !== 0) {
      return;
    }
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolveIdle of waiters) {
      resolveIdle();
    }
  }
}
