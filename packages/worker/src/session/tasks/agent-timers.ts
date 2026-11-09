/**
 * Agent timer abstraction.
 *
 * Agents can create session-scoped timers that wake the agent later
 * (Claude's CronCreate, ScheduleWakeup and /loop). Claude Code schedules
 * them: it fires a timer while its process runs and the session is idle
 * (later than the cron says, by an offset fixed by the timer's id; see
 * claudeTimerNextFire), and brings its timers back when the session
 * resumes. Foundry observes them through SDK hooks, and the device keeps
 * them for the next process that runs the session (session-timers.ts). Every
 * runtime exposes an {@link AgentTimersCapability}; only Claude supports
 * timers today, the headless Codex protocol has no equivalent.
 *
 * A timer's turn runs while no Foundry turn owns the agent process. The
 * tracker marks that turn when Claude submits the timer's prompt and
 * publishes that it fired; the runner publishes it again with its answer
 * when it ends (see takeFire). Both carry its start time, which names it.
 */

import { processLabels } from "@bd777/foundry-protocol";
import {
  claudeTimerNextFire,
  cronTimeZone,
  cronWallTime,
  humanizeCron,
  localTimeZone,
  type AgentSessionEvent,
  type AgentScheduledTask,
} from "@bd777/foundry-protocol";

// Cron parsing/humanization is shared with the web UI through the protocol
// package; re-exported so worker code can keep importing it from this module.
export { humanizeCron, nextCronFire, parseCron } from "@bd777/foundry-protocol";

// --- Capability surface ---------------------------------------------------

export interface AgentTimersCapability {
  readonly provider: "claude" | "codex";
  readonly supported: boolean;
}

export const claudeTimersCapability: AgentTimersCapability = {
  provider: "claude",
  supported: true,
};

export const codexTimersCapability: AgentTimersCapability = {
  provider: "codex",
  supported: false,
};

// --- Event labels (the web keys timers off metadata, not these) ---------

export const timerSyncLabel = processLabels.timerSync;
export const timerFireLabel = processLabels.timerFire;
export const backgroundTurnLabel = processLabels.backgroundTurn;

export interface TimerSinkEvent {
  detail: string;
  level?: AgentSessionEvent["level"];
  metadata?: AgentSessionEvent["metadata"];
  message?: AgentSessionEvent["message"];
  label: string;
}

export interface ClaudeTimerSink {
  /** True while a Foundry turn owns the process; turns then belong to it. */
  isActiveTurn: () => boolean;
  /** Route a timer event to the active turn or the out-of-band channel. */
  emit: (event: TimerSinkEvent) => void;
  /** Foundry session id the runtime is currently attached to. */
  sessionId: () => string;
  /** The session's timers changed (the device keeps them; see session-timers.ts). */
  timersChanged?: (tasks: AgentScheduledTask[]) => void;
  /** An authoritative SDK inventory, including an empty first snapshot. */
  timersObserved?: (tasks: AgentScheduledTask[]) => void;
  /**
   * Wake-ups of an earlier process the device still delivers for the
   * session (session-timers.ts): the session waits on them too, so the
   * timers it reports include them.
   */
  deviceWakeups?: () => AgentScheduledTask[];
  /**
   * Claude fired one of the session's timers (its prompt names it): the
   * device does not deliver that due time again (timer-revival.ts).
   */
  timerFired?: (task: AgentScheduledTask) => void;
  /**
   * Claude starts a timer's turn on its own, before it reads the prompt:
   * the process gets what the turn needs (a current Foundry token).
   */
  timerTurnStarting?: () => Promise<void>;
}

/** A turn Claude started for a timer: from its prompt until its result. */
export interface ClaudeTimerTurn {
  /** The timer, when its prompt names one the session holds. */
  id?: string;
  prompt: string;
  startedAt: string;
  /**
   * Published as it started (no Foundry turn ran): its end must be
   * published too, with its answer or without.
   */
  announced?: boolean;
}

/** A timer turn's fire as events carry it: unfinished, or with its end. */
export function timerFireEvent(
  fire: ClaudeTimerTurn,
  end?: { completedAt: string; response?: string; failed?: boolean },
): TimerSinkEvent {
  return {
    label: timerFireLabel,
    detail: fire.prompt.split(/\r?\n/)[0]?.slice(0, 200) ?? "",
    level: end?.failed ? "error" : "info",
    metadata: {
      timerFire: {
        ...(fire.id ? { id: fire.id } : {}),
        origin: "scheduled",
        prompt: fire.prompt,
        ...(end?.response ? { response: end.response } : {}),
        startedAt: fire.startedAt,
        completedAt: end?.completedAt ?? "",
      },
    },
  };
}

// --- Claude tracker -------------------------------------------------------

interface StopHookInput {
  agent_id?: string;
  session_crons?: Array<{
    id: string;
    prompt: string;
    recurring: boolean;
    schedule: string;
  }>;
}

interface PostToolUseHookInput {
  agent_id?: string;
  tool_input?: Record<string, unknown>;
  tool_name?: string;
  tool_response?: unknown;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResponse?: unknown;
}

interface UserPromptSubmitHookInput {
  agent_id?: string;
  prompt?: string;
}

/** Claude Code's prompt for a background task's end, not a timer's. */
const taskNotificationPrompt = /^\s*<task-notification>/;

type TimerTool = NonNullable<AgentScheduledTask["createdBy"]>;

/**
 * The time zone Claude's cron fields are in: Claude Code applies its
 * settings' `env` over its process environment, and reads times in that
 * TZ, else in the system's zone (this process's, when it sets none).
 */
export function claudeTimeZone(
  processEnv: Record<string, string | undefined> | undefined,
  settingsEnv?: Record<string, unknown>,
): string {
  const fromSettings =
    typeof settingsEnv?.TZ === "string" ? settingsEnv.TZ : undefined;
  return (
    cronTimeZone(fromSettings) ??
    cronTimeZone(processEnv?.TZ) ??
    cronTimeZone(process.env.TZ) ??
    localTimeZone()
  );
}

/** A one-time cron for the minute `at` names in `timeZone`. */
function oneTimeSchedule(at: Date, timeZone: string): string {
  const wall = cronWallTime(at, timeZone);
  return `${wall.getUTCMinutes()} ${wall.getUTCHours()} ${wall.getUTCDate()} ${wall.getUTCMonth() + 1} *`;
}

/**
 * Whether a listed one-time schedule names the minute `at` in `timeZone`:
 * Claude Code lists a wakeup as its minute and hour ("42 21 * * *"), with
 * or without its day and month.
 */
function scheduleNames(
  schedule: string,
  at: string | undefined,
  timeZone: string,
): boolean {
  const date = at ? new Date(at) : undefined;
  if (!date || Number.isNaN(date.getTime())) return false;
  const wall = cronWallTime(date, timeZone);
  const [minute, hour, day, month] = schedule.trim().split(/\s+/);
  const matches = (field: string | undefined, value: number) =>
    field === "*" || Number(field) === value;
  return (
    Number(minute) === wall.getUTCMinutes() &&
    Number(hour) === wall.getUTCHours() &&
    matches(day, wall.getUTCDate()) &&
    matches(month, wall.getUTCMonth() + 1)
  );
}

function toScheduledTask(
  raw: {
    id: string;
    prompt: string;
    recurring: boolean;
    schedule: string;
  },
  now: Date,
  timeZone: string,
  origin: { createdBy?: TimerTool; fireAt?: string } = {},
): AgentScheduledTask {
  const next =
    origin.fireAt ??
    claudeTimerNextFire({ ...raw, timeZone }, now)?.toISOString();
  return {
    humanSchedule: humanizeCron(
      raw.schedule,
      raw.recurring,
      now,
      "zh-CN",
      timeZone,
    ),
    id: raw.id,
    kind: raw.recurring ? "cron" : "wakeup",
    nextFireAt: next,
    prompt: raw.prompt,
    recurring: raw.recurring,
    schedule: raw.schedule,
    timeZone,
    ...(origin.createdBy ? { createdBy: origin.createdBy } : {}),
  };
}

/**
 * Observes Claude session timers through SDK hooks for one long-lived runtime
 * and forwards snapshots through the sink.
 */
export class ClaudeTimerTracker {
  private readonly tasks = new Map<string, AgentScheduledTask>();
  private lastSignature = "";
  /** Whether this process reported the session's timers yet. */
  private reportedOnce = false;
  private closed = false;
  private firing?: ClaudeTimerTurn;

  /**
   * `known` are the session's timers from before this process: Claude Code
   * brings them back when it resumes the session. `timeZone` is the zone
   * the process reads its timers' cron fields in (claudeTimeZone).
   */
  constructor(
    private readonly sink: ClaudeTimerSink,
    known: readonly AgentScheduledTask[] = [],
    private timeZone: string = claudeTimeZone(undefined),
  ) {
    for (const task of known) this.tasks.set(task.id, task);
    if (this.reported().length > 0) this.lastSignature = this.signature();
  }

  /** The process's environment is final (a connection may set its TZ). */
  setTimeZone(timeZone: string): void {
    this.timeZone = timeZone;
  }

  /** Options fragment merged into the Claude SDK `query()` options. */
  hooks(): Record<string, unknown> {
    return {
      PostToolUse: [
        {
          hooks: [async (input: unknown) => this.handlePostToolUse(input)],
        },
      ],
      Stop: [
        {
          hooks: [
            async (input: unknown) => this.handleStop(input as StopHookInput),
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            async (input: unknown) =>
              await this.handlePromptSubmit(input as UserPromptSubmitHookInput),
          ],
        },
      ],
    };
  }

  snapshot(): AgentScheduledTask[] {
    return [...this.tasks.values()];
  }

  /**
   * The timer turn running since Claude submitted its prompt, once: the
   * runner publishes it with its answer when the turn ends, or drops it when
   * a Foundry turn took the stream.
   */
  takeFire(): ClaudeTimerTurn | undefined {
    const fire = this.firing;
    this.firing = undefined;
    return fire;
  }

  /** A timer turn runs that was published as it started: Claude's own. */
  isFiring(id: string): boolean {
    return this.firing?.id === id;
  }

  announcedFire(): boolean {
    return Boolean(this.firing?.announced);
  }

  /**
   * The timer turn running, if any, ends unanswered: a Foundry turn took
   * the stream, or the process ended. One published as it started is
   * published as ended, so no reader waits on it.
   */
  dropFire(): void {
    const fire = this.takeFire();
    if (fire?.announced)
      this.sink.emit(
        timerFireEvent(fire, { completedAt: new Date().toISOString() }),
      );
  }

  /**
   * The agent process is gone. Its timers are not: Claude Code brings them
   * back when the session resumes. Returns them.
   */
  close(): AgentScheduledTask[] {
    if (!this.closed) this.dropFire();
    this.closed = true;
    this.firing = undefined;
    return this.snapshot();
  }

  /**
   * Claude submits a timer's prompt itself when the timer fires (in the
   * transcript a meta prompt of origin "scheduled"): a prompt naming one of
   * the session's timers, or any prompt while no Foundry turn runs, starts
   * a timer's turn. A Foundry turn's own prompt and steers name none.
   */
  private async handlePromptSubmit(
    input: UserPromptSubmitHookInput,
  ): Promise<undefined> {
    if (this.closed || input.agent_id) return undefined;
    const prompt = String(input.prompt ?? "").trim();
    if (!prompt || taskNotificationPrompt.test(prompt)) return undefined;
    const id = this.matchTimerId(prompt);
    if (!id && this.sink.isActiveTurn()) return undefined;
    const task = id ? this.tasks.get(id) : undefined;
    if (task) this.sink.timerFired?.(task);
    this.firing = { id, prompt, startedAt: new Date().toISOString() };
    // A Foundry turn's dispatch brought a fresh token already, and the
    // session shows that turn running.
    if (this.sink.isActiveTurn()) return undefined;
    // Published now, so readers know it fired and runs (a timer's turn may
    // run for an hour); the runner publishes its end with its answer.
    this.firing.announced = true;
    this.sink.emit(timerFireEvent(this.firing));
    await this.sink.timerTurnStarting?.();
    return undefined;
  }

  private handlePostToolUse(input: unknown): undefined {
    const hook = input as PostToolUseHookInput;
    if (hook.agent_id) {
      // Subagent timers belong to the subagent session, not the main thread.
      return undefined;
    }
    const toolName = hook.tool_name ?? hook.toolName;
    const toolInput = hook.tool_input ?? hook.toolInput ?? {};
    const toolResponse = hook.tool_response ?? hook.toolResponse;
    if (toolName === "CronCreate") {
      const cron = String(toolInput.cron ?? "");
      const prompt = String(toolInput.prompt ?? "");
      const response = (toolResponse ?? {}) as Record<string, unknown>;
      const id = String(response.id ?? "");
      const recurring =
        typeof response.recurring === "boolean"
          ? response.recurring
          : toolInput.recurring !== false;
      if (id && cron) {
        this.upsert(
          { id, prompt, recurring, schedule: cron },
          { createdBy: "CronCreate" },
        );
      }
    } else if (toolName === "CronDelete") {
      const id = String(toolInput.id ?? "");
      if (id) {
        this.tasks.delete(id);
        this.emitSnapshot();
      }
    } else if (toolName === "ScheduleWakeup") {
      // The wake-up gets its id only in the Stop hook's session_crons; show
      // it now as a one-time cron at the time Claude scheduled, which the
      // Stop hook's list then replaces.
      const response = (toolResponse ?? {}) as Record<string, unknown>;
      const delaySeconds = Number(toolInput.delaySeconds);
      const scheduledFor =
        Number(response.scheduledFor) ||
        (Number.isFinite(delaySeconds) && delaySeconds > 0
          ? Date.now() + Math.min(3600, Math.max(60, delaySeconds)) * 1000
          : 0);
      if (scheduledFor > 0) {
        const at = new Date(scheduledFor);
        this.upsert(
          {
            id: `wakeup-${scheduledFor}`,
            prompt: String(toolInput.prompt ?? ""),
            recurring: false,
            schedule: oneTimeSchedule(at, this.timeZone),
          },
          { createdBy: "ScheduleWakeup", fireAt: at.toISOString() },
        );
      }
    } else if (toolName === "CronList") {
      const response = toolResponse as
        { jobs?: Array<Record<string, unknown>> } | undefined;
      const jobs = response?.jobs;
      if (Array.isArray(jobs)) {
        this.replaceFromJobs(jobs);
      }
    }
    return undefined;
  }

  private async handleStop(input: StopHookInput): Promise<undefined> {
    if (this.closed || input.agent_id || !Array.isArray(input.session_crons)) {
      return undefined;
    }
    const crons = Array.isArray(input.session_crons) ? input.session_crons : [];
    // Claude's first list in this process is reported even when it is
    // empty or what the device kept: what an earlier process reported may
    // be gone (a wakeup Claude does not bring back, one the device
    // delivered meanwhile).
    const first = !this.reportedOnce;
    this.replaceFromJobs(
      crons.map((cron) => ({
        cron: cron.schedule,
        id: cron.id,
        prompt: cron.prompt,
        recurring: cron.recurring,
      })),
      first,
    );
    if (Array.isArray(input.session_crons))
      this.sink.timersObserved?.(this.snapshot());
    return undefined;
  }

  private upsert(
    raw: {
      id: string;
      prompt: string;
      recurring: boolean;
      schedule: string;
    },
    origin: { createdBy?: TimerTool; fireAt?: string },
  ): void {
    const now = new Date();
    this.tasks.set(raw.id, toScheduledTask(raw, now, this.timeZone, origin));
    this.emitSnapshot();
  }

  private replaceFromJobs(
    jobs: Array<Record<string, unknown>>,
    force = false,
  ): void {
    const next = new Map<string, AgentScheduledTask>();
    const now = new Date();
    for (const job of jobs) {
      const id = String(job.id ?? "");
      const schedule = String(job.cron ?? job.schedule ?? "");
      if (!id || !schedule) {
        continue;
      }
      const reported = String(job.prompt ?? "");
      // Claude caps a listed prompt (session_crons) at 1000 characters;
      // the full one CronCreate saw stays.
      const known = this.tasks.get(id)?.prompt;
      const prompt =
        known && known.length > reported.length && clippedFrom(reported, known)
          ? known
          : reported;
      const recurring = job.recurring !== false;
      next.set(
        id,
        toScheduledTask(
          {
            id,
            prompt,
            recurring,
            schedule,
          },
          now,
          this.timeZone,
          this.originOf(id, prompt, schedule, recurring),
        ),
      );
    }
    this.tasks.clear();
    for (const [id, task] of next) {
      this.tasks.set(id, task);
    }
    this.emitSnapshot(force);
  }

  /**
   * Which tool made a listed timer: the one recorded under its id, or the
   * wake-up shown under a provisional id (`wakeup-<ms>`) whose prompt and
   * minute it has. A wake-up keeps the exact time Claude scheduled it for.
   */
  private originOf(
    id: string,
    prompt: string,
    schedule: string,
    recurring: boolean,
  ): { createdBy?: TimerTool; fireAt?: string } {
    const known = this.tasks.get(id);
    if (known?.createdBy)
      return {
        createdBy: known.createdBy,
        ...(known.createdBy === "ScheduleWakeup" && known.nextFireAt
          ? { fireAt: known.nextFireAt }
          : {}),
      };
    if (recurring) return {};
    for (const task of this.tasks.values())
      if (
        task.createdBy === "ScheduleWakeup" &&
        task.id.startsWith("wakeup-") &&
        scheduleNames(schedule, task.nextFireAt, this.timeZone) &&
        (task.prompt === prompt || clippedFrom(prompt, task.prompt))
      )
        return {
          createdBy: "ScheduleWakeup",
          ...(task.nextFireAt ? { fireAt: task.nextFireAt } : {}),
        };
    return {};
  }

  /**
   * The timers the session waits on: Claude's, and the wake-ups of an
   * earlier process the device delivers.
   */
  private reported(): AgentScheduledTask[] {
    const held = this.snapshot();
    const owed = (this.sink.deviceWakeups?.() ?? []).filter(
      (task) => !this.tasks.has(task.id),
    );
    return owed.length ? [...held, ...owed] : held;
  }

  private signature(): string {
    return JSON.stringify(
      this.reported().map((task) => [
        task.id,
        task.schedule,
        task.recurring,
        task.prompt,
      ]),
    );
  }

  private emitSnapshot(force = false): void {
    if (this.closed) {
      return;
    }
    const signature = this.signature();
    // An empty list before any timer existed says nothing, but for Claude's
    // first list (force).
    if (
      !force &&
      (signature === this.lastSignature ||
        (this.lastSignature === "" && this.reported().length === 0))
    ) {
      return;
    }
    this.lastSignature = signature;
    this.dispatchSnapshot();
  }

  private dispatchSnapshot(): void {
    this.reportedOnce = true;
    // The device keeps what Claude holds; the session shows what it waits on.
    this.sink.timersChanged?.(this.snapshot());
    const snapshot = this.reported();
    const detail =
      snapshot.length > 0
        ? snapshot.map((task) => task.humanSchedule).join("、")
        : "";
    this.sink.emit({
      detail,
      metadata: { timerSnapshot: snapshot },
      label: timerSyncLabel,
    });
  }

  private matchTimerId(prompt: string): string | undefined {
    const head = prompt.slice(0, 200);
    for (const task of this.tasks.values()) {
      const timerPrompt = task.prompt.trim();
      if (
        timerPrompt &&
        (timerPrompt === prompt ||
          timerPrompt.startsWith(head) ||
          clippedFrom(timerPrompt, prompt))
      ) {
        return task.id;
      }
    }
    return undefined;
  }
}

/** Whether `listed` is `full` as Claude lists it, cut with "… [+N chars]". */
function clippedFrom(listed: string, full: string): boolean {
  const match = /^([\s\S]*?)… \[\+\d+ chars\]$/.exec(listed);
  return Boolean(match?.[1] && full.startsWith(match[1]));
}
