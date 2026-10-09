import type {
  AgentTurnUsage,
  ModelRequestUsage,
  SubagentUsage,
} from "@bd777/foundry-protocol";

/** Token usage without the duration, which the runner measures itself. */
export type TurnTokenUsage = Omit<AgentTurnUsage, "durationMs">;

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Usage of a Claude Agent SDK `result` message. Claude reports cache reads
 * and writes beside `input_tokens`, so the prompt total is their sum. Its
 * `total_cost_usd` is not used: it accumulates over the runtime's whole life,
 * while `usage` covers just this result.
 */
export function claudeResultUsage(
  message: unknown,
): TurnTokenUsage | undefined {
  const result = record(message);
  if (result?.type !== "result") return undefined;
  const usage = record(result.usage);
  if (!usage) return undefined;
  const cacheReadTokens = count(usage.cache_read_input_tokens);
  const cacheWriteTokens = count(usage.cache_creation_input_tokens);
  return {
    inputTokens: count(usage.input_tokens) + cacheReadTokens + cacheWriteTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: count(usage.output_tokens),
    ...(count(result.num_turns) > 0
      ? { modelRequests: count(result.num_turns) }
      : {}),
  };
}

/**
 * Usage of a Codex SDK `turn.completed` event (or a buffered turn). Codex
 * counts cached tokens inside `input_tokens` and reasoning inside
 * `output_tokens`.
 */
export function codexTurnUsage(event: unknown): TurnTokenUsage | undefined {
  const turn = record(event);
  const usage = record(turn?.usage);
  if (!usage) return undefined;
  return {
    inputTokens: count(usage.input_tokens),
    cacheReadTokens: count(usage.cached_input_tokens),
    cacheWriteTokens: count(usage.cache_write_input_tokens),
    outputTokens: count(usage.output_tokens),
    reasoningTokens: count(usage.reasoning_output_tokens),
  };
}

/** One Foundry turn can span several provider results (background tasks). */
export function addTurnUsage(
  total: TurnTokenUsage | undefined,
  next: TurnTokenUsage,
): TurnTokenUsage {
  if (!total) return next;
  const optional = (key: "reasoningTokens" | "modelRequests") =>
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
    requestId: left.requestId,
    inputTokens: Math.max(left.inputTokens, right.inputTokens),
    cacheReadTokens: Math.max(left.cacheReadTokens, right.cacheReadTokens),
    cacheWriteTokens: Math.max(left.cacheWriteTokens, right.cacheWriteTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
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
  const inner = record(record(message)?.message);
  const usage = record(inner?.usage);
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

  observe(message: unknown): ModelRequestUsage | undefined {
    const value = record(message);
    if (!value || value.parent_tool_use_id) return undefined;
    if (value.type === "assistant") {
      const usage = claudeRequestUsage(message);
      if (usage && this.current?.requestId === usage.requestId)
        this.current = mergeRequestUsage(this.current, usage);
      return undefined;
    }
    if (value.type !== "stream_event") return undefined;
    const event = record(value.event);
    if (event?.type === "message_start") {
      const started = record(event.message);
      const requestId = typeof started?.id === "string" ? started.id : "";
      this.current = requestId
        ? requestUsageOf(requestId, record(started?.usage) ?? {})
        : undefined;
      this.reported = false;
      return undefined;
    }
    if (!this.current || this.reported) return undefined;
    if (event?.type === "message_delta") {
      const delta = record(event.usage);
      if (delta)
        this.current = mergeRequestUsage(
          this.current,
          requestUsageOf(this.current.requestId, delta),
        );
    } else if (event?.type !== "message_stop") {
      return undefined;
    }
    this.reported = true;
    return hasRequestUsage(this.current) ? this.current : undefined;
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
  return record(record(value)?.usage);
}
