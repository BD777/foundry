/**
 * Agent timer abstraction.
 *
 * Agents can create session-scoped timers that wake the agent later
 * (Claude's CronCreate/ScheduleWakeup). The application layer must observe
 * those timers without knowing provider-specific mechanics, so every runtime
 * exposes an {@link AgentTimersCapability}. Only Claude supports timers today;
 * the headless Codex protocol has no equivalent.
 *
 * Timer events can arrive while no Foundry turn owns the agent process (the
 * timer wakes the long-lived process directly). Trackers therefore emit
 * through a sink that routes to either the active turn or the out-of-band
 * session-event channel.
 */

import { readFileSync } from "node:fs";
import {
  humanizeCron,
  nextCronFire,
  type AgentSessionEvent,
  type AgentSessionTimerFire,
  type AgentScheduledTask,
} from "@foundry/protocol";

// Cron parsing/humanization is shared with the web UI through the protocol
// package; re-exported so worker code can keep importing it from this module.
export { humanizeCron, nextCronFire, parseCron } from "@foundry/protocol";

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

// --- Event labels (also referenced by the web transcript filter) ---------

export const timerSyncLabel = "定时任务更新";
export const timerFireLabel = "定时任务触发";
export const backgroundTurnLabel = "后台任务继续";

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
}

// --- Claude tracker -------------------------------------------------------

interface StopHookInput {
  agent_id?: string;
  last_assistant_message?: string;
  session_crons?: Array<{
    id: string;
    prompt: string;
    recurring: boolean;
    schedule: string;
  }>;
  transcript_path?: string;
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

interface TranscriptTailTurn {
  completedAt?: string;
  origin: AgentSessionTimerFire["origin"];
  prompt: string;
  response?: string;
  startedAt?: string;
}

const transcriptTailBytes = 131072;
const transcriptTailRows = 300;

function recordText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "text"
          ? String((block as Record<string, unknown>).text ?? "")
          : "",
      )
      .join("")
      .trim();
  }
  return "";
}

/**
 * Recover the most recent user prompt turn from a transcript tail. Cron wake
 * prompts land as ordinary user records with `turnOrigin: "scheduled"`.
 */
function readTranscriptTailTurn(
  transcriptPath: string | undefined,
): TranscriptTailTurn | undefined {
  if (!transcriptPath) {
    return undefined;
  }
  let rows: Array<Record<string, unknown>> = [];
  try {
    const buffer = readFileSync(transcriptPath);
    const slice = buffer.subarray(
      Math.max(0, buffer.length - transcriptTailBytes),
    );
    rows = slice
      .toString("utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().startsWith("{"))
      .slice(-transcriptTailRows)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return {};
        }
      });
  } catch {
    return undefined;
  }

  let response: string | undefined;
  let completedAt: string | undefined;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.type === "assistant" && !response) {
      const message = row.message as Record<string, unknown> | undefined;
      const text = recordText(message?.content);
      if (text) {
        response = text;
        completedAt =
          typeof row.timestamp === "string" ? row.timestamp : undefined;
      }
    }
    if (row?.type === "user") {
      const message = row.message as Record<string, unknown> | undefined;
      const prompt = recordText(message?.content);
      // Only timer-driven wakes carry the scheduled origin marker. A normal
      // Foundry turn whose Stop hook races result-resolution must never be
      // mistaken for a background turn.
      if (prompt && row.turnOrigin === "scheduled") {
        return {
          completedAt,
          origin: "scheduled",
          prompt,
          response,
          startedAt:
            typeof row.timestamp === "string" ? row.timestamp : undefined,
        };
      }
    }
  }
  return undefined;
}

function toScheduledTask(
  raw: {
    id: string;
    prompt: string;
    recurring: boolean;
    schedule: string;
  },
  now: Date,
): AgentScheduledTask {
  const next = raw.recurring ? nextCronFire(raw.schedule, now) : undefined;
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
 * and forwards snapshot/fire events through the sink.
 */
export class ClaudeTimerTracker {
  private readonly tasks = new Map<string, AgentScheduledTask>();
  private lastSignature = "";
  private closed = false;

  constructor(private readonly sink: ClaudeTimerSink) {}

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
    };
  }

  snapshot(): AgentScheduledTask[] {
    return [...this.tasks.values()];
  }

  /** The agent process is gone; its in-memory timers died with it. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.tasks.size > 0) {
      this.tasks.clear();
      this.lastSignature = "";
      this.dispatchSnapshot();
    }
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

    if (!this.sink.isActiveTurn()) {
      const turn = readTranscriptTailTurn(input.transcript_path);
      if (
        turn &&
        (turn.origin === "scheduled" || turn.origin === "background")
      ) {
        this.emitFire(turn, input.last_assistant_message ?? turn.response);
      }
    }
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
      next.set(
        id,
        toScheduledTask(
          {
            id,
            prompt: String(job.prompt ?? ""),
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
    if (!force && signature === this.lastSignature) {
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
    this.sink.emit({
      detail,
      metadata: { timerSnapshot: snapshot },
      label: timerSyncLabel,
    });
  }

  private emitFire(turn: TranscriptTailTurn, fallbackResponse?: string): void {
    const response = (turn.response || fallbackResponse || "").trim();
    const completedAt = turn.completedAt ?? new Date().toISOString();
    const prompt = turn.prompt.trim();
    const timerId = this.matchTimerId(prompt);
    const fire: AgentSessionTimerFire = {
      completedAt,
      id: timerId,
      origin: turn.origin,
      prompt,
      response: response || undefined,
      startedAt: turn.startedAt,
    };
    const label =
      turn.origin === "scheduled" ? timerFireLabel : backgroundTurnLabel;
    // No typed message here: the web layer decides how a timer-triggered
    // turn is rendered (a divider plus the auto-produced response).
    this.sink.emit({
      detail: prompt.split(/\r?\n/)[0]?.slice(0, 200) ?? prompt.slice(0, 200),
      metadata: { timerFire: fire },
      label,
    });
  }

  private matchTimerId(prompt: string): string | undefined {
    const head = prompt.slice(0, 200);
    for (const task of this.tasks.values()) {
      if (task.prompt === prompt || task.prompt.startsWith(head)) {
        return task.id;
      }
    }
    return undefined;
  }
}
