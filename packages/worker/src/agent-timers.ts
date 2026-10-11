/**
 * Agent timer abstraction.
 *
 * Agents can create session-scoped timers that wake the agent later
 * (Claude's CronCreate, ScheduleWakeup and /loop). Claude Code schedules
 * them: it fires a timer while its process runs and the session is idle
 * (later than the cron says, by an offset fixed by the timer's id; see
 * claudeTimerNextFire), and brings its timers back when the session
 * resumes. Foundry observes them through SDK hooks, and resumes a session
 * whose timer is due while no process runs it (session-timers.ts). Every
 * runtime exposes an {@link AgentTimersCapability}; only Claude supports
 * timers today, the headless Codex protocol has no equivalent.
 *
 * A timer's turn runs while no Foundry turn owns the agent process. The
 * tracker marks that turn when Claude submits the timer's prompt; the runner
 * publishes it with its answer when it ends (see takeFire).
 */

import { processLabels } from "@bd777/foundry-protocol";
import {
  claudeTimerNextFire,
  humanizeCron,
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

function toScheduledTask(
  raw: {
    id: string;
    prompt: string;
    recurring: boolean;
    schedule: string;
  },
  now: Date,
): AgentScheduledTask {
  const next = claudeTimerNextFire(raw, now);
  return {
    humanSchedule: humanizeCron(raw.schedule, raw.recurring, now),
    id: raw.id,
    kind: raw.recurring ? "cron" : "wakeup",
    nextFireAt: next?.toISOString(),
    prompt: raw.prompt,
    recurring: raw.recurring,
    schedule: raw.schedule,
  };
}

/**
 * Observes Claude session timers through SDK hooks for one long-lived runtime
 * and forwards snapshots through the sink.
 */
export class ClaudeTimerTracker {
  private readonly tasks = new Map<string, AgentScheduledTask>();
  private lastSignature = "";
  private closed = false;
  private firing?: ClaudeTimerTurn;

  /**
   * `known` are the session's timers from before this process: Claude Code
   * brings them back when it resumes the session.
   */
  constructor(
    private readonly sink: ClaudeTimerSink,
    known: readonly AgentScheduledTask[] = [],
  ) {
    for (const task of known) this.tasks.set(task.id, task);
    if (this.tasks.size > 0) this.lastSignature = this.signature();
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

  /**
   * The agent process is gone. Its timers are not: Claude Code brings them
   * back when the session resumes. Returns them.
   */
  close(): AgentScheduledTask[] {
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
    this.firing = { id, prompt, startedAt: new Date().toISOString() };
    // A Foundry turn's dispatch brought a fresh token already.
    if (!this.sink.isActiveTurn()) await this.sink.timerTurnStarting?.();
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
        this.upsert({ id, prompt, recurring, schedule: cron });
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
        this.upsert({
          id: `wakeup-${scheduledFor}`,
          prompt: String(toolInput.prompt ?? ""),
          recurring: false,
          schedule: `${at.getMinutes()} ${at.getHours()} ${at.getDate()} ${at.getMonth() + 1} *`,
        });
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
    if (this.closed || input.agent_id) {
      return undefined;
    }
    const crons = Array.isArray(input.session_crons) ? input.session_crons : [];
    this.replaceFromJobs(
      crons.map((cron) => ({
        cron: cron.schedule,
        id: cron.id,
        prompt: cron.prompt,
        recurring: cron.recurring,
      })),
    );
    return undefined;
  }

  private upsert(raw: {
    id: string;
    prompt: string;
    recurring: boolean;
    schedule: string;
  }): void {
    const now = new Date();
    this.tasks.set(raw.id, toScheduledTask(raw, now));
    this.emitSnapshot();
  }

  private replaceFromJobs(jobs: Array<Record<string, unknown>>): void {
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
      next.set(
        id,
        toScheduledTask(
          {
            id,
            prompt,
            recurring: job.recurring !== false,
            schedule,
          },
          now,
        ),
      );
    }
    this.tasks.clear();
    for (const [id, task] of next) {
      this.tasks.set(id, task);
    }
    this.emitSnapshot();
  }

  private signature(): string {
    return JSON.stringify(
      [...this.tasks.values()].map((task) => [
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
    // An empty list before any timer existed says nothing.
    if (
      !force &&
      (signature === this.lastSignature ||
        (this.lastSignature === "" && this.tasks.size === 0))
    ) {
      return;
    }
    this.lastSignature = signature;
    this.dispatchSnapshot();
  }

  private dispatchSnapshot(): void {
    const snapshot = this.snapshot();
    const detail =
      snapshot.length > 0
        ? snapshot.map((task) => task.humanSchedule).join("、")
        : "";
    this.sink.timersChanged?.(snapshot);
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
