import type { AgentTurnUsage } from "@bd777/foundry-protocol";
import { optionalRecord } from "../../platform/json-values.js";

export type AgentTimingEstimate = Pick<
  AgentTurnUsage,
  "modelMs" | "ttftMs" | "timingEstimated"
>;

const toolItemTypes = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "webSearch",
]);
const outputDeltaMethods = new Set([
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/plan/delta",
]);
const outputItemTypes = new Set(["agentMessage", "reasoning", "plan"]);

function milliseconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function unixSecondsToMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value * 1000)
    : undefined;
}

function elapsedMilliseconds(from: number, to: number): number {
  return Math.max(0, Math.round(to - from));
}

function mergedDuration(
  intervals: Array<[number, number]>,
  from: number,
  to: number,
): number {
  const clipped = intervals
    .map(([start, end]): [number, number] => [
      Math.max(from, start),
      Math.min(to, end),
    ])
    .filter(([start, end]) => end >= start)
    .sort((left, right) => left[0] - right[0]);
  let total = 0;
  let start: number | undefined;
  let end: number | undefined;
  for (const interval of clipped) {
    const nextStart = interval[0];
    const nextEnd = interval[1];
    if (start === undefined || end === undefined) {
      start = nextStart;
      end = nextEnd;
    } else if (nextStart <= end) {
      end = Math.max(end, nextEnd);
    } else {
      total += end - start;
      start = nextStart;
      end = nextEnd;
    }
  }
  return start !== undefined && end !== undefined ? total + end - start : 0;
}

/**
 * Codex reports no model-only duration. Reconstruct one from the turn's wall
 * time minus the union of command, file, MCP and web-search item intervals.
 * TTFT is the first model-output delta, falling back to an output item when
 * an older producer sends no delta.
 */
export class CodexTimingTracker {
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly openTools = new Map<string, number>();
  private readonly toolIntervals: Array<[number, number]> = [];
  private firstDeltaAt?: number;
  private firstOutputItemAt?: number;

  constructor(options: { startedAt?: number; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.startedAt = options.startedAt ?? this.now();
  }

  observe(method: string, params: unknown): void {
    const at = this.now();
    if (outputDeltaMethods.has(method)) this.firstDeltaAt ??= at;
    const item = optionalRecord(optionalRecord(params)?.item);
    if (!item) return;
    const type = typeof item.type === "string" ? item.type : "";
    if (
      (method === "item/started" || method === "item/completed") &&
      outputItemTypes.has(type)
    )
      this.firstOutputItemAt ??= at;
    if (method !== "item/started" && method !== "item/completed") return;
    if (!toolItemTypes.has(type) || typeof item.id !== "string") return;
    if (method === "item/started") {
      this.openTools.set(item.id, milliseconds(item.startedAtMs) ?? at);
      return;
    }
    const startedAt =
      milliseconds(item.startedAtMs) ?? this.openTools.get(item.id);
    if (startedAt === undefined) return;
    const completedAt = milliseconds(item.completedAtMs) ?? at;
    this.openTools.delete(item.id);
    if (completedAt >= startedAt)
      this.toolIntervals.push([startedAt, completedAt]);
  }

  finish(turn: unknown): AgentTimingEstimate {
    const record = optionalRecord(turn);
    const turnStartedAt = unixSecondsToMs(record?.startedAt) ?? this.startedAt;
    const reportedDuration = milliseconds(record?.durationMs);
    const reportedCompletedAt = unixSecondsToMs(record?.completedAt);
    const durationMs =
      reportedDuration ??
      (reportedCompletedAt !== undefined
        ? elapsedMilliseconds(turnStartedAt, reportedCompletedAt)
        : elapsedMilliseconds(turnStartedAt, this.now()));
    const turnCompletedAt = reportedCompletedAt ?? turnStartedAt + durationMs;
    const toolMs = mergedDuration(
      this.toolIntervals,
      turnStartedAt,
      turnCompletedAt,
    );
    const outputAt = this.firstDeltaAt ?? this.firstOutputItemAt;
    return {
      modelMs: Math.max(0, durationMs - toolMs),
      ...(outputAt !== undefined
        ? { ttftMs: elapsedMilliseconds(turnStartedAt, outputAt) }
        : {}),
      timingEstimated: true,
    };
  }
}
