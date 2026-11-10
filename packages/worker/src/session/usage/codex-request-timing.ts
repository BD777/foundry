import { optionalRecord } from "../../platform/json-values.js";

const minimumEstimatedTimingMs = 1_000;
const maximumEstimatedTokensPerSecond = 1_000;

const outputItemTypes = new Set(["agentMessage", "plan", "reasoning"]);
const toolItemTypes = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "webSearch",
]);

export function estimatedTimingReliable(
  outputTokens: number,
  elapsedMs: number,
): boolean {
  if (
    !Number.isFinite(outputTokens) ||
    outputTokens < 0 ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs < minimumEstimatedTimingMs
  )
    return false;
  return outputTokens / (elapsedMs / 1_000) <= maximumEstimatedTokensPerSecond;
}

interface RequestInterval {
  startedAt: number;
  endedAt: number;
}

function milliseconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function elapsedMilliseconds(from: number, to: number): number {
  return Math.max(0, Math.round(to - from));
}

/**
 * Times one Codex model request from the input being handed to the model to
 * the last output item of its response. A token-usage update reports the
 * request's tokens, not its end: Codex may deliver that update only after tool
 * execution, so it is matched to the most recent completed response.
 */
export class CodexRequestTimingTracker {
  private readonly now: () => number;
  private requestStartedAt: number;
  private responseEndedAt?: number;
  private responseAssigned = false;
  private readonly openTools = new Set<string>();
  private readonly completedResponses: RequestInterval[] = [];

  constructor(options: { startedAt?: number; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.requestStartedAt = options.startedAt ?? this.now();
  }

  observe(method: string, params: unknown, at = this.now()): void {
    const record = optionalRecord(params);
    if (method === "turn/started") {
      const turn = optionalRecord(record?.turn);
      this.requestStartedAt = milliseconds(turn?.startedAtMs) ?? at;
      this.responseEndedAt = undefined;
      this.responseAssigned = false;
      this.openTools.clear();
      this.completedResponses.length = 0;
      return;
    }

    if (method !== "item/started" && method !== "item/completed") return;
    const item = optionalRecord(record?.item);
    const type = typeof item?.type === "string" ? item.type : "";
    if (outputItemTypes.has(type) && method === "item/completed") {
      this.responseEndedAt = milliseconds(item?.completedAtMs) ?? at;
      return;
    }
    if (!toolItemTypes.has(type)) return;

    const id = typeof item?.id === "string" ? item.id : "";
    if (method === "item/started") {
      this.openTools.add(id);
      this.responseEndedAt = milliseconds(item?.startedAtMs) ?? at;
      return;
    }

    this.openTools.delete(id);
    if (this.openTools.size > 0) return;
    const completedAt = milliseconds(item?.completedAtMs) ?? at;
    if (this.responseEndedAt !== undefined && !this.responseAssigned) {
      this.completedResponses.push({
        startedAt: this.requestStartedAt,
        endedAt: this.responseEndedAt,
      });
    }
    // A tool result starts the next model request once every parallel result
    // in the batch is available.
    this.requestStartedAt = completedAt;
    this.responseEndedAt = undefined;
    this.responseAssigned = false;
  }

  /**
   * Takes the response that the next token-usage update belongs to. Updates
   * arrive in request order, so several delayed updates remain paired even
   * when a later response has already ended.
   */
  takeRequestMs(): number | undefined {
    let response = this.completedResponses.shift();
    if (
      !response &&
      this.responseEndedAt !== undefined &&
      !this.responseAssigned
    ) {
      response = {
        startedAt: this.requestStartedAt,
        endedAt: this.responseEndedAt,
      };
      this.responseAssigned = true;
    }
    return response
      ? elapsedMilliseconds(response.startedAt, response.endedAt)
      : undefined;
  }
}
