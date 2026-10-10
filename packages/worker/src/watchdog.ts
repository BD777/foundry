/**
 * Turn liveness for agent runtimes.
 *
 * Silence is never a death signal. A turn is alive while its agent process
 * is: the pump sees the process exit, the stream end or throw. What the turn
 * is busy with — a tool call, a model request or its retries, compaction,
 * background work — is tracked from the agent's own messages, so expected
 * silence is known. Each operation is measured against the runtime's own
 * bound for it (Claude Code's `BASH_*_TIMEOUT_MS`, `API_TIMEOUT_MS`,
 * `MCP_TOOL_TIMEOUT`; Codex's stream idle timeout); past that bound, or after
 * a long quiet with nothing in flight, the person gets a notice and can stop
 * the turn. Nothing here kills a turn for being quiet.
 *
 * Two bounds still fail a turn: a freshly started process that never
 * reaches the model (a startup hang), and an absolute ceiling per turn.
 */
import {
  claudeToolUseDetail,
  isForwardedClaudeSubagentMessage,
} from "./sdk-messages.js";

export type TurnOperationKind = "tool" | "model" | "compaction";

export interface TurnOperation {
  id: string;
  kind: TurnOperationKind;
  /** What the person sees, e.g. "Bash" or "model request". */
  name: string;
  /** The tool call as it was shown when it started. */
  detail?: string;
  startedAt: number;
  /** Last sign of progress (stream events, for a model request). */
  activeAt: number;
  /** The runtime's own bound, measured from `activeAt`; none if unbounded. */
  boundMs?: number;
  /** The setting the bound comes from, named in the notice. */
  boundSource?: string;
  overdueNoticed?: boolean;
}

export type TurnLivenessNotice =
  | { kind: "quiet"; quietMs: number }
  | { kind: "overdue"; operation: TurnOperation; elapsedMs: number };

export type TurnStartupPhase = "spawn" | "first response";

export type TurnLivenessFailure =
  | { kind: "startup"; phase: TurnStartupPhase; waitedMs: number }
  | { kind: "ceiling"; elapsedMs: number };

export interface TurnLivenessOptions {
  /** Quiet with nothing in flight for this long is reported, once. */
  quietNoticeMs: number;
  /**
   * A freshly started process: launch → its first message. Absent for a
   * runtime that is already running.
   */
  startupTimeoutMs?: number;
  /** A freshly started process: first message → the model's first sign. */
  firstResponseTimeoutMs?: number;
  /** Last-resort ceiling per turn; 0 turns it off. */
  ceilingMs: number;
  /** Added to an operation's own bound before it looks stuck. */
  graceMs: number;
  /** Work beyond the turn's own operations: background tasks, timers. */
  backgroundBusy?: () => boolean;
  onNotice: (notice: TurnLivenessNotice) => void;
  onFailure: (failure: TurnLivenessFailure) => void;
  now?: () => number;
  checkIntervalMs?: number;
}

const minute = 60_000;

export function positiveMs(
  value: string | undefined,
  fallback: number,
  { allowZero = false }: { allowZero?: boolean } = {},
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed === 0 && allowZero) return 0;
  return parsed > 0 ? Math.round(parsed) : fallback;
}

/**
 * Foundry's own liveness settings. Defaults: a notice after 10 minutes of
 * quiet with nothing in flight, 3 minutes for a new process to answer at
 * all, 2 minutes' grace past an operation's own bound, a 12 hour ceiling.
 */
export function turnLivenessSettings(env: NodeJS.ProcessEnv = process.env): {
  quietNoticeMs: number;
  startupTimeoutMs: number;
  graceMs: number;
  ceilingMs: number;
} {
  return {
    quietNoticeMs: positiveMs(env.FOUNDRY_TURN_QUIET_NOTICE_MS, 10 * minute),
    startupTimeoutMs: positiveMs(
      env.FOUNDRY_AGENT_STARTUP_TIMEOUT_MS,
      3 * minute,
    ),
    graceMs: positiveMs(env.FOUNDRY_TURN_OPERATION_GRACE_MS, 2 * minute),
    ceilingMs: positiveMs(env.FOUNDRY_TURN_MAX_DURATION_MS, 12 * 60 * minute, {
      allowZero: true,
    }),
  };
}

export class TurnLiveness {
  private readonly operations = new Map<string, TurnOperation>();
  private readonly startedAt: number;
  private lastActivityAt: number;
  private quietNoticed = false;
  private startupPhase: TurnStartupPhase | undefined;
  private phaseStartedAt: number;
  private closed = false;
  private readonly timer: NodeJS.Timeout;

  constructor(protected readonly options: TurnLivenessOptions) {
    this.startedAt = this.now();
    this.lastActivityAt = this.startedAt;
    this.phaseStartedAt = this.startedAt;
    if (options.startupTimeoutMs) this.startupPhase = "spawn";
    const interval =
      options.checkIntervalMs ??
      Math.max(
        50,
        Math.min(15_000, Math.floor(options.quietNoticeMs / 4) || 15_000),
      );
    this.timer = setInterval(() => this.check(), interval);
    this.timer.unref?.();
  }

  protected now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Any message from the agent process. */
  activity(): void {
    this.lastActivityAt = this.now();
    this.quietNoticed = false;
    if (this.startupPhase === "spawn") {
      this.startupPhase = "first response";
      this.phaseStartedAt = this.lastActivityAt;
    }
  }

  /** The agent reached the model: start-up is over. */
  responding(): void {
    this.activity();
    this.startupPhase = undefined;
  }

  begin(
    operation: Omit<TurnOperation, "startedAt" | "activeAt"> & {
      startedAt?: number;
    },
  ): void {
    const now = this.now();
    this.operations.set(operation.id, {
      ...operation,
      startedAt: operation.startedAt ?? now,
      activeAt: now,
    });
  }

  /** Progress on an operation restarts its bound. */
  progress(id: string): void {
    const operation = this.operations.get(id);
    if (!operation) return;
    operation.activeAt = this.now();
    operation.overdueNoticed = false;
  }

  end(id: string): TurnOperation | undefined {
    const operation = this.operations.get(id);
    this.operations.delete(id);
    return operation;
  }

  endAll(kind?: TurnOperationKind): void {
    for (const [id, operation] of this.operations)
      if (!kind || operation.kind === kind) this.operations.delete(id);
  }

  inFlight(): TurnOperation[] {
    return [...this.operations.values()];
  }

  busy(): boolean {
    return this.operations.size > 0 || Boolean(this.options.backgroundBusy?.());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
  }

  /** Evaluates the bounds; the timer calls it, tests may too. */
  check(): void {
    if (this.closed) return;
    const now = this.now();
    if (this.startupPhase) {
      const bound =
        this.startupPhase === "spawn"
          ? this.options.startupTimeoutMs
          : this.options.firstResponseTimeoutMs;
      if (bound && now - this.phaseStartedAt >= bound) {
        const phase = this.startupPhase;
        this.close();
        this.options.onFailure({
          kind: "startup",
          phase,
          waitedMs: now - this.startedAt,
        });
        return;
      }
      // Until the agent reaches the model, only the start-up bound applies.
      return;
    }
    if (
      this.options.ceilingMs > 0 &&
      now - this.startedAt >= this.options.ceilingMs
    ) {
      this.close();
      this.options.onFailure({
        kind: "ceiling",
        elapsedMs: now - this.startedAt,
      });
      return;
    }
    for (const operation of this.operations.values()) {
      if (operation.boundMs === undefined || operation.overdueNoticed) continue;
      if (now - operation.activeAt < operation.boundMs + this.options.graceMs)
        continue;
      operation.overdueNoticed = true;
      this.options.onNotice({
        kind: "overdue",
        operation,
        elapsedMs: now - operation.startedAt,
      });
    }
    if (
      !this.quietNoticed &&
      !this.busy() &&
      now - this.lastActivityAt >= this.options.quietNoticeMs
    ) {
      this.quietNoticed = true;
      this.options.onNotice({
        kind: "quiet",
        quietMs: now - this.lastActivityAt,
      });
    }
  }
}

/** A minute-or-second rendering for notices. */
export function livenessDuration(ms: number): string {
  if (ms < minute) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const minutes = Math.round(ms / minute);
  if (minutes < 120) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

/** What a liveness notice tells the person. */
export function turnLivenessNoticeText(notice: TurnLivenessNotice): string {
  if (notice.kind === "quiet")
    return `No progress for ${livenessDuration(notice.quietMs)} and nothing is known to be running — the agent may be stuck. It keeps running; stop it if it does not continue.`;
  const { operation } = notice;
  const bound =
    operation.boundMs !== undefined
      ? `, past its ${livenessDuration(operation.boundMs)} limit${operation.boundSource ? ` (${operation.boundSource})` : ""}`
      : "";
  const what =
    operation.kind === "tool"
      ? `${operation.name} has been running for ${livenessDuration(notice.elapsedMs)}`
      : operation.kind === "compaction"
        ? `Compacting the context has had no progress for ${livenessDuration(notice.elapsedMs)}`
        : `The model request has had no response for ${livenessDuration(notice.elapsedMs)}`;
  return `${what}${bound} — it may be stuck. The turn keeps running; stop it if it does not continue.`;
}

// --- Claude Code ---

/**
 * The bounds Claude Code itself applies, read from the environment its
 * process gets (https://code.claude.com/docs/en/env-vars).
 */
export interface ClaudeOperationBounds {
  /** `API_TIMEOUT_MS`, per model request attempt; default 10 minutes. */
  apiTimeoutMs: number;
  /** `BASH_DEFAULT_TIMEOUT_MS`, a foreground command; default 2 minutes. */
  bashDefaultTimeoutMs: number;
  /** `BASH_MAX_TIMEOUT_MS`, the most a command may ask; default 10 minutes. */
  bashMaxTimeoutMs: number;
  /** `MCP_TOOL_TIMEOUT`, an MCP tool call; default 100000000 ms (~28 h). */
  mcpToolTimeoutMs: number;
}

export function claudeOperationBounds(
  env: Record<string, string | undefined>,
): ClaudeOperationBounds {
  return {
    apiTimeoutMs: positiveMs(env.API_TIMEOUT_MS, 600_000),
    bashDefaultTimeoutMs: positiveMs(env.BASH_DEFAULT_TIMEOUT_MS, 120_000),
    bashMaxTimeoutMs: positiveMs(env.BASH_MAX_TIMEOUT_MS, 600_000),
    mcpToolTimeoutMs: positiveMs(env.MCP_TOOL_TIMEOUT, 100_000_000),
  };
}

/**
 * Claude Code's own limit for a tool call, when it has one. A foreground
 * command that reaches it moves to the background and the call returns; a
 * tool without a documented limit runs unbounded and stays visible as
 * running.
 */
export function claudeToolBound(
  name: string,
  input: unknown,
  bounds: ClaudeOperationBounds,
): { boundMs: number; boundSource: string } | undefined {
  const args =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  if (name === "Bash" || name === "PowerShell") {
    if (args.run_in_background === true) return undefined;
    const ceiling = Math.max(
      bounds.bashMaxTimeoutMs,
      bounds.bashDefaultTimeoutMs,
    );
    const requested =
      typeof args.timeout === "number" && args.timeout > 0
        ? args.timeout
        : undefined;
    return requested !== undefined
      ? {
          boundMs: Math.min(requested, ceiling),
          boundSource: "the command's timeout",
        }
      : {
          boundMs: bounds.bashDefaultTimeoutMs,
          boundSource: "BASH_DEFAULT_TIMEOUT_MS",
        };
  }
  if (name.startsWith("mcp__"))
    return {
      boundMs: bounds.mcpToolTimeoutMs,
      boundSource: "MCP_TOOL_TIMEOUT",
    };
  return undefined;
}

export interface FinishedClaudeTool {
  id: string;
  name: string;
  detail: string;
  failed: boolean;
}

const claudeModelOperation = "model";
const claudeCompactionOperation = "compaction";

function contentBlocks(message: Record<string, unknown>): unknown[] {
  const content = (message.message as Record<string, unknown> | undefined)
    ?.content;
  return Array.isArray(content) ? content : [];
}

/** Liveness of one Claude turn, read from the SDK message stream. */
export class ClaudeTurnLiveness extends TurnLiveness {
  constructor(
    options: TurnLivenessOptions,
    private readonly bounds: ClaudeOperationBounds,
  ) {
    super(options);
  }

  private beginModelRequest(name: string, boundMs: number): void {
    this.begin({
      id: claudeModelOperation,
      kind: "model",
      name,
      boundMs,
      boundSource: "API_TIMEOUT_MS",
    });
  }

  /**
   * Follows one SDK message. Returns the tool calls it finished, so their
   * rows can say so.
   */
  observe(message: unknown): FinishedClaudeTool[] {
    this.activity();
    if (!message || typeof message !== "object") return [];
    // A subagent's own messages are progress of its Task call, which stays
    // in flight until its result.
    if (isForwardedClaudeSubagentMessage(message)) return [];
    const record = message as Record<string, unknown>;
    switch (record.type) {
      case "stream_event": {
        const event = record.event as Record<string, unknown> | undefined;
        this.responding();
        if (event?.type === "message_start") {
          this.beginModelRequest("model request", this.bounds.apiTimeoutMs);
        } else if (event?.type === "message_stop") {
          this.end(claudeModelOperation);
        } else {
          // Includes gateway keep-alive pings: the request is alive.
          this.progress(claudeModelOperation);
        }
        return [];
      }
      case "assistant": {
        this.responding();
        for (const value of contentBlocks(record)) {
          const block = value as Record<string, unknown> | undefined;
          if (block?.type !== "tool_use" || typeof block.id !== "string")
            continue;
          const name = typeof block.name === "string" ? block.name : "tool";
          this.begin({
            id: block.id,
            kind: "tool",
            name,
            detail: claudeToolUseDetail(block),
            ...claudeToolBound(name, block.input, this.bounds),
          });
        }
        return [];
      }
      case "user": {
        const finished: FinishedClaudeTool[] = [];
        for (const value of contentBlocks(record)) {
          const block = value as Record<string, unknown> | undefined;
          if (
            block?.type !== "tool_result" ||
            typeof block.tool_use_id !== "string"
          )
            continue;
          const operation = this.end(block.tool_use_id);
          if (operation?.detail !== undefined)
            finished.push({
              id: operation.id,
              name: operation.name,
              detail: operation.detail,
              failed: block.is_error === true,
            });
        }
        return finished;
      }
      case "tool_progress":
        this.responding();
        if (typeof record.tool_use_id === "string")
          this.progress(record.tool_use_id);
        return [];
      case "result":
        this.responding();
        // The model turn is over; nothing of it is still in flight.
        this.endAll();
        return [];
      case "system":
        this.observeSystem(record);
        return [];
      default:
        return [];
    }
  }

  private observeSystem(record: Record<string, unknown>): void {
    switch (record.subtype) {
      case "status":
        if (record.status === "requesting") {
          this.beginModelRequest("model request", this.bounds.apiTimeoutMs);
        } else if (record.status === "compacting") {
          this.responding();
          this.begin({
            id: claudeCompactionOperation,
            kind: "compaction",
            name: "compaction",
            boundMs: this.bounds.apiTimeoutMs,
            boundSource: "API_TIMEOUT_MS",
          });
        } else {
          this.end(claudeCompactionOperation);
        }
        return;
      case "compact_boundary":
        this.end(claudeCompactionOperation);
        return;
      case "api_retry": {
        // Claude Code reached the API and retries visibly: it is working.
        this.responding();
        const delay =
          typeof record.retry_delay_ms === "number" &&
          Number.isFinite(record.retry_delay_ms) &&
          record.retry_delay_ms > 0
            ? record.retry_delay_ms
            : 0;
        this.beginModelRequest(
          "model request retry",
          delay + this.bounds.apiTimeoutMs,
        );
        return;
      }
      default:
        return;
    }
  }
}

// --- Codex ---

/**
 * Codex's own stream idle timeout (`model_providers.<id>.stream_idle_timeout_ms`,
 * default 300000; https://developers.openai.com/codex/config-reference).
 */
export const codexStreamIdleTimeoutMs = 300_000;

const codexToolItemTypes = new Set([
  "command_execution",
  "mcp_tool_call",
  "web_search",
  "file_change",
]);

/**
 * Liveness of one Codex turn, read from its thread events. While a tool item
 * runs the model waits on it; otherwise the turn waits on the model stream.
 */
export class CodexTurnLiveness extends TurnLiveness {
  private turnOpen = false;

  private awaitModel(): void {
    if (!this.turnOpen || this.inFlight().some((op) => op.kind === "tool"))
      return;
    this.begin({
      id: "model",
      kind: "model",
      name: "model request",
      boundMs: codexStreamIdleTimeoutMs,
      boundSource: "stream_idle_timeout_ms",
    });
  }

  observe(event: unknown): void {
    this.responding();
    if (!event || typeof event !== "object") return;
    const record = event as Record<string, unknown>;
    const item = record.item as Record<string, unknown> | undefined;
    switch (record.type) {
      case "turn.started":
        this.turnOpen = true;
        this.awaitModel();
        return;
      case "item.started":
        if (
          item &&
          typeof item.id === "string" &&
          codexToolItemTypes.has(String(item.type))
        ) {
          this.end("model");
          this.begin({
            id: `item:${item.id}`,
            kind: "tool",
            name:
              item.type === "command_execution"
                ? "Command"
                : item.type === "mcp_tool_call"
                  ? `${String(item.server ?? "MCP")} ${String(item.tool ?? "tool")}`
                  : String(item.type),
          });
        } else {
          this.progress("model");
        }
        return;
      case "item.completed":
        if (item && typeof item.id === "string") this.end(`item:${item.id}`);
        this.progress("model");
        this.awaitModel();
        return;
      case "turn.completed":
      case "turn.failed":
        this.turnOpen = false;
        this.endAll();
        return;
      default:
        this.progress("model");
    }
  }
}
