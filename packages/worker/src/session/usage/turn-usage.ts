import type {
  AgentTurnUsage,
  ModelRequestUsage,
  SubagentUsage,
} from "@bd777/foundry-protocol";
import { count, optionalRecord } from "../../platform/json-values.js";

/** Token and model timing usage without the turn's wall duration. */
export type TurnTokenUsage = Omit<AgentTurnUsage, "durationMs">;

function milliseconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function elapsedMilliseconds(from: number, to: number): number {
  return Math.max(0, Math.round(to - from));
}

function carriesToolResult(message: unknown): boolean {
  const content = optionalRecord(optionalRecord(message)?.message)?.content;
  return (
    Array.isArray(content) &&
    content.some((part) => optionalRecord(part)?.type === "tool_result")
  );
}

/**
 * Usage of a Claude Agent SDK `result` message. Claude reports cache reads
 * and writes beside `input_tokens`, so the prompt total is their sum. Its
 * `total_cost_usd` accumulates over the runtime's whole life, while `usage`
 * covers just this result: the result's own cost, when known, is passed in
 * (see ClaudeContextTracker).
 */
export function claudeResultUsage(
  message: unknown,
  costUsd?: number,
): TurnTokenUsage | undefined {
  const result = optionalRecord(message);
  if (result?.type !== "result") return undefined;
  const usage = optionalRecord(result.usage);
  if (!usage) return undefined;
  const cacheReadTokens = count(usage.cache_read_input_tokens);
  const cacheWriteTokens = count(usage.cache_creation_input_tokens);
  const modelMs = milliseconds(result.duration_api_ms);
  const ttftMs =
    milliseconds(result.ttft_stream_ms) ?? milliseconds(result.ttft_ms);
  return {
    inputTokens: count(usage.input_tokens) + cacheReadTokens + cacheWriteTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: count(usage.output_tokens),
    ...(count(result.num_turns) > 0
      ? { modelRequests: count(result.num_turns) }
      : {}),
    ...(modelMs !== undefined ? { modelMs } : {}),
    ...(ttftMs !== undefined ? { ttftMs } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/**
 * Usage of a Codex SDK `turn.completed` event (or a buffered turn). Codex
 * counts cached tokens inside `input_tokens` and reasoning inside
 * `output_tokens`.
 */
export function codexTurnUsage(event: unknown): TurnTokenUsage | undefined {
  const turn = optionalRecord(event);
  const usage = optionalRecord(turn?.usage);
  if (!usage) return undefined;
  const timing = optionalRecord(turn?.timing);
  const modelMs = milliseconds(timing?.modelMs);
  const ttftMs = milliseconds(timing?.ttftMs);
  return {
    inputTokens: count(usage.input_tokens),
    cacheReadTokens: count(usage.cached_input_tokens),
    cacheWriteTokens: count(usage.cache_write_input_tokens),
    outputTokens: count(usage.output_tokens),
    reasoningTokens: count(usage.reasoning_output_tokens),
    ...(modelMs !== undefined ? { modelMs } : {}),
    ...(ttftMs !== undefined ? { ttftMs } : {}),
    ...(timing?.timingEstimated === true ? { timingEstimated: true } : {}),
  };
}

/**
 * One Foundry turn can span several provider results (background tasks). Its
 * cost is known only when every result's is.
 */
export function addTurnUsage(
  total: TurnTokenUsage | undefined,
  next: TurnTokenUsage,
): TurnTokenUsage {
  if (!total) return next;
  const optional = (key: "reasoningTokens" | "modelRequests" | "modelMs") =>
    total[key] === undefined && next[key] === undefined
      ? {}
      : { [key]: (total[key] ?? 0) + (next[key] ?? 0) };
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    cacheReadTokens: total.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + next.cacheWriteTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    ...optional("reasoningTokens"),
    ...optional("modelRequests"),
    ...(total.modelMs !== undefined && next.modelMs !== undefined
      ? optional("modelMs")
      : {}),
    ...(total.ttftMs !== undefined
      ? { ttftMs: total.ttftMs }
      : next.ttftMs !== undefined
        ? { ttftMs: next.ttftMs }
        : {}),
    ...(total.timingEstimated || next.timingEstimated
      ? { timingEstimated: true }
      : {}),
    ...(total.costUsd !== undefined && next.costUsd !== undefined
      ? { costUsd: total.costUsd + next.costUsd }
      : {}),
  };
}

export function turnUsageMetadata(
  usage: TurnTokenUsage | undefined,
  startedAt: number,
): { turnUsage: AgentTurnUsage } | undefined {
  return usage
    ? {
        turnUsage: {
          durationMs: Math.max(0, Date.now() - startedAt),
          ...usage,
        },
      }
    : undefined;
}

/**
 * Tokens of the model request behind a Claude `assistant` message. The SDK
 * splits one request's content blocks over several messages with the same id.
 */
function requestUsageOf(
  requestId: string,
  usage: Record<string, unknown>,
): ModelRequestUsage {
  const cacheReadTokens = count(usage.cache_read_input_tokens);
  const cacheWriteTokens = count(usage.cache_creation_input_tokens);
  return {
    requestId,
    inputTokens: count(usage.input_tokens) + cacheReadTokens + cacheWriteTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: count(usage.output_tokens),
  };
}

/** Whether a request report counts anything; relays often report zeros. */
export function hasRequestUsage(usage: ModelRequestUsage): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.cacheReadTokens > 0 ||
    usage.cacheWriteTokens > 0
  );
}

/** Reports of one request are snapshots; the largest of each field counts. */
export function mergeRequestUsage(
  left: ModelRequestUsage,
  right: ModelRequestUsage,
): ModelRequestUsage {
  return {
    ...left,
    requestId: left.requestId,
    inputTokens: Math.max(left.inputTokens, right.inputTokens),
    cacheReadTokens: Math.max(left.cacheReadTokens, right.cacheReadTokens),
    cacheWriteTokens: Math.max(left.cacheWriteTokens, right.cacheWriteTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
  };
}

/**
 * A request's tokens once its `message_delta` arrives. What `message_start`
 * (and the assistant messages repeating it) said about the prompt is an
 * estimate: some relays overstate it several times over, others send zeros.
 * Each prompt count the delta reports replaces it, as Claude Code's own
 * result usage does; output only grows.
 */
function settledRequestUsage(
  provisional: ModelRequestUsage,
  delta: Record<string, unknown>,
): ModelRequestUsage {
  const reported = (value: unknown, fallback: number) =>
    count(value) > 0 ? count(value) : fallback;
  const cacheReadTokens = reported(
    delta.cache_read_input_tokens,
    provisional.cacheReadTokens,
  );
  const cacheWriteTokens = reported(
    delta.cache_creation_input_tokens,
    provisional.cacheWriteTokens,
  );
  const provisionalInput =
    provisional.inputTokens -
    provisional.cacheReadTokens -
    provisional.cacheWriteTokens;
  const uncachedTokens = reported(delta.input_tokens, provisionalInput);
  return {
    ...provisional,
    inputTokens: uncachedTokens + cacheReadTokens + cacheWriteTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: Math.max(
      provisional.outputTokens,
      count(delta.output_tokens),
    ),
  };
}

/**
 * Tokens of the model request behind a Claude `assistant` message, when it
 * reports any. The SDK splits one request's content blocks over several
 * messages with the same id, each carrying the usage known when the block
 * was sent: often zeros (always, through some relays). The request's final
 * tokens come from its stream; see ClaudeRequestUsageTracker.
 */
export function claudeRequestUsage(
  message: unknown,
): ModelRequestUsage | undefined {
  const inner = optionalRecord(optionalRecord(message)?.message);
  const usage = optionalRecord(inner?.usage);
  const requestId = typeof inner?.id === "string" ? inner.id : "";
  if (!usage || !requestId) return undefined;
  const value = requestUsageOf(requestId, usage);
  return hasRequestUsage(value) ? value : undefined;
}

/**
 * Follows the main agent's model requests through the SDK's stream events
 * (`message_start` names the request and its prompt tokens, `message_delta`
 * carries the final counts) and yields each request's tokens once, when its
 * stream ends. Subagents' streams (parent_tool_use_id set) are not followed.
 */
export class ClaudeRequestUsageTracker {
  private current?: ModelRequestUsage;
  private reported = false;
  private requestStartedAt: number;
  private startedAt?: number;
  private firstDeltaAt?: number;
  private readonly now: () => number;

  constructor(options: { startedAt?: number; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.requestStartedAt = options.startedAt ?? this.now();
  }

  observe(message: unknown): ModelRequestUsage | undefined {
    const value = optionalRecord(message);
    if (!value || value.parent_tool_use_id) return undefined;
    if (value.type === "assistant") {
      const usage = claudeRequestUsage(message);
      if (usage && this.current?.requestId === usage.requestId)
        this.current = mergeRequestUsage(this.current, usage);
      return undefined;
    }
    if (value.type === "user") {
      if (carriesToolResult(message)) this.requestStartedAt = this.now();
      return undefined;
    }
    if (value.type === "result") return this.flush();
    if (value.type !== "stream_event") return undefined;
    const event = optionalRecord(value.event);
    if (event?.type === "message_start") {
      const started = optionalRecord(event.message);
      const requestId = typeof started?.id === "string" ? started.id : "";
      this.current = requestId
        ? requestUsageOf(requestId, optionalRecord(started?.usage) ?? {})
        : undefined;
      this.reported = false;
      this.startedAt = this.current ? this.now() : undefined;
      this.firstDeltaAt = undefined;
      return undefined;
    }
    if (!this.current || this.reported) return undefined;
    if (event?.type === "content_block_delta") {
      if (this.firstDeltaAt === undefined && this.startedAt !== undefined) {
        this.firstDeltaAt = this.now();
        this.current = {
          ...this.current,
          firstTokenMs: elapsedMilliseconds(this.startedAt, this.firstDeltaAt),
        };
      }
      return undefined;
    } else if (event?.type === "message_delta") {
      const delta = optionalRecord(event.usage);
      if (delta) this.current = settledRequestUsage(this.current, delta);
      return undefined;
    }
    if (event?.type !== "message_stop") return undefined;
    const stoppedAt = this.now();
    if (this.firstDeltaAt !== undefined) {
      this.current = {
        ...this.current,
        generationMs: elapsedMilliseconds(this.firstDeltaAt, stoppedAt),
      };
    }
    this.current = {
      ...this.current,
      requestMs: elapsedMilliseconds(this.requestStartedAt, stoppedAt),
    };
    return this.finish();
  }

  /** Emits a request whose stream ended without its `message_stop`. */
  flush(): ModelRequestUsage | undefined {
    return this.finish();
  }

  private finish(): ModelRequestUsage | undefined {
    if (!this.current || this.reported) return undefined;
    this.reported = true;
    const usage = this.current;
    this.startedAt = undefined;
    this.firstDeltaAt = undefined;
    this.current = undefined;
    return hasRequestUsage(usage) ? usage : undefined;
  }
}

/**
 * A Claude subagent's usage from a `task_progress` or `task_notification`
 * record: Claude reports one token total, tool calls and wall time.
 */
export function claudeSubagentUsage(
  record: unknown,
): SubagentUsage | undefined {
  const usage = usageRecord(record);
  if (!usage) return undefined;
  return {
    totalTokens: count(usage.total_tokens),
    toolUses: count(usage.tool_uses),
    durationMs: count(usage.duration_ms),
  };
}

function usageRecord(value: unknown): Record<string, unknown> | undefined {
  return optionalRecord(optionalRecord(value)?.usage);
}
