/**
 * Concurrent task scheduler with per-key serialization and idle waiting.
 */

import {
  sessionSources,
  type AgentSession,
  type DeviceRuntimeState,
} from "@bd777/foundry-protocol";

export type TurnAdmissionClass = "exempt" | "limited";

/** Human chat turns and parents waiting on children do not consume a slot. */
export function sessionAdmissionClass(
  session: Pick<
    AgentSession,
    "input" | "parentSessionId" | "role" | "source" | "waitingChildCount"
  >,
): TurnAdmissionClass {
  if ((session.waitingChildCount ?? 0) > 0) return "exempt";
  const humanTurn =
    !session.parentSessionId &&
    !session.input?.sentBySessionId &&
    !session.input?.timerFire &&
    (!session.source ||
      session.source === sessionSources.chat ||
      session.role === "issue_clarification");
  return humanTurn ? "exempt" : "limited";
}

/** What a running task runs, for resource attribution. */
export interface ScheduledTaskContext {
  admissionClass?: TurnAdmissionClass;
  runtime?: string;
  sessionId?: string;
  workspaceId?: string;
}

/** Why a scheduled task did not start at once. */
export interface SchedulerWait {
  /** Tasks running now. */
  running: number;
  /** Limited tasks running now. */
  runningLimited: number;
  /** Tasks exempt from the limit running now. */
  runningExempt: number;
  /** How many may run at once. */
  limit: number;
  /** Tasks waiting, including this one. */
  queued: number;
  /** Limited tasks waiting now. */
  queuedLimited: number;
  /** Limit-exempt tasks waiting now. */
  queuedExempt: number;
  /** No new task starts until the host frees memory. */
  hardHold: boolean;
  /** Admission reason codes behind the limit or hold. */
  reasons: string[];
  /** A task with the same key runs: this one follows it, whatever the limit. */
  sameKey: boolean;
}

type ScheduledTask = {
  context?: ScheduledTaskContext;
  key: string;
  reject: (error: unknown) => void;
  resolve: (value: unknown) => void;
  run: () => Promise<unknown> | unknown;
};

export interface SchedulerAdmission {
  hardHold?: boolean;
  limit: number;
  reasons?: string[];
}

export function normalizeMaxConcurrentTasks(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return 4;
  }
  return Math.min(16, Math.max(1, Math.round(value)));
}

export class ConcurrentTaskScheduler {
  private active = 0;
  private activeExempt = 0;
  private activeKeys = new Set<string>();
  private activeLimited = 0;
  private activeTasks = new Map<ScheduledTask, ScheduledTaskContext>();
  private hardHold = false;
  private idleWaiters: Array<() => void> = [];
  private maxConcurrentTasks: number;
  private queued: ScheduledTask[] = [];
  private reasons: string[] = [];
  private runtimeState?: DeviceRuntimeState;

  constructor(maxConcurrentTasks: number | SchedulerAdmission) {
    const admission =
      typeof maxConcurrentTasks === "number"
        ? { limit: maxConcurrentTasks }
        : maxConcurrentTasks;
    this.maxConcurrentTasks = normalizeMaxConcurrentTasks(admission.limit);
    this.hardHold = admission.hardHold ?? false;
    this.reasons = [...(admission.reasons ?? [])];
  }

  /** Runs the task when there is room; onWait hears at once if there is none. */
  schedule<T>(
    key: string,
    run: () => Promise<T> | T,
    onWait?: (wait: SchedulerWait) => void,
    context?: ScheduledTaskContext,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: ScheduledTask = {
        ...(context ? { context } : {}),
        key: key.trim() || `task_${this.queued.length}`,
        reject,
        resolve: (value) => resolve(value as T),
        run,
      };
      this.queued.push(task);
      this.drain();
      if (onWait && this.queued.includes(task)) {
        const load = this.load();
        onWait({
          running: load.running,
          runningExempt: load.runningExempt,
          runningLimited: load.runningLimited,
          limit: this.maxConcurrentTasks,
          queued: load.queued,
          queuedExempt: load.queuedExempt,
          queuedLimited: load.queuedLimited,
          hardHold: this.hardHold,
          reasons: [...this.reasons],
          sameKey: this.activeKeys.has(task.key),
        });
      }
    });
  }

  /** Tasks running now and how many may. */
  load(): {
    hardHold: boolean;
    limit: number;
    queued: number;
    queuedExempt: number;
    queuedLimited: number;
    reasons: string[];
    running: number;
    runningExempt: number;
    runningLimited: number;
  } {
    return {
      hardHold: this.hardHold,
      limit: this.maxConcurrentTasks,
      queued: this.queued.length,
      queuedExempt: this.queued.filter(
        (task) => task.context?.admissionClass === "exempt",
      ).length,
      queuedLimited: this.queued.filter(
        (task) => task.context?.admissionClass !== "exempt",
      ).length,
      reasons: [...this.reasons],
      running: this.active,
      runningExempt: this.activeExempt,
      runningLimited: this.activeLimited,
    };
  }

  /** What the turns running now are, for matching their process groups. */
  runningContexts(): ScheduledTaskContext[] {
    return [...this.activeTasks.values()];
  }

  /** What queued tasks will run, for estimating their resource needs. */
  queuedContexts(): ScheduledTaskContext[] {
    return this.queued.flatMap((task) => (task.context ? [task.context] : []));
  }

  /**
   * Applies a resource policy. A hold prevents new starts; lowering the
   * limit never stops a turn already running.
   */
  configureAdmission(admission: SchedulerAdmission): void {
    this.maxConcurrentTasks = normalizeMaxConcurrentTasks(admission.limit);
    this.hardHold = admission.hardHold ?? false;
    this.reasons = [...(admission.reasons ?? [])];
    this.drain();
  }

  setRuntimeState(state: DeviceRuntimeState | undefined): void {
    this.runtimeState = state;
  }

  currentRuntimeState(): DeviceRuntimeState | undefined {
    return this.runtimeState;
  }

  /** Compatibility for older callers; new code uses configureAdmission. */
  setMaxConcurrentTasks(maxConcurrentTasks: number): void {
    this.configureAdmission({ limit: maxConcurrentTasks });
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
    if (this.hardHold) return;
    while (true) {
      const nextIndex = this.queued.findIndex((task) => {
        if (this.activeKeys.has(task.key)) return false;
        return (
          task.context?.admissionClass === "exempt" ||
          this.activeLimited < this.maxConcurrentTasks
        );
      });
      if (nextIndex < 0) {
        break;
      }
      const [task] = this.queued.splice(nextIndex, 1);
      if (!task) {
        break;
      }
      const exempt = task.context?.admissionClass === "exempt";
      this.active += 1;
      if (exempt) this.activeExempt += 1;
      else this.activeLimited += 1;
      this.activeKeys.add(task.key);
      this.activeTasks.set(task, task.context ?? {});
      void Promise.resolve()
        .then(task.run)
        .then(task.resolve, task.reject)
        .finally(() => {
          this.active -= 1;
          if (exempt) this.activeExempt -= 1;
          else this.activeLimited -= 1;
          this.activeKeys.delete(task.key);
          this.activeTasks.delete(task);
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
