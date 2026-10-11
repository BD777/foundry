/**
 * How full a session's context is, as its runtime reports it: after each of
 * the main agent's model requests, the whole input that request sent, and
 * the model's context window. Claude names the window in its results;
 * Codex in the `token_count` records of its rollout log.
 */
import type { AgentContextUsage } from "@bd777/foundry-protocol";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { findSessionLog } from "./native-usage.js";
import { ClaudeRequestUsageTracker } from "./turn-usage.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sameContext(
  left: AgentContextUsage | undefined,
  right: AgentContextUsage,
): boolean {
  return (
    left !== undefined &&
    !left.compaction &&
    left.inputTokens === right.inputTokens &&
    left.contextWindow === right.contextWindow &&
    left.model === right.model
  );
}

/** Context windows Claude reported, by model: the same for every session. */
const claudeContextWindows = new Map<string, number>();

/**
 * Follows a Claude process: each main-agent model request's input as its
 * stream ends, the window its results report, compactions, and what each
 * result cost. `total_cost_usd` adds up over the process's life, so a
 * result's cost is what the total grew by; a resumed process may start
 * from an earlier total, so its first result's cost is unknown.
 */
export class ClaudeContextTracker {
  private readonly requests = new ClaudeRequestUsageTracker();
  private model?: string;
  private reported?: AgentContextUsage;
  private costTotal?: number;
  private readonly costs = new WeakMap<object, number>();

  constructor(options: { resumed: boolean }) {
    this.costTotal = options.resumed ? undefined : 0;
  }

  /** The context to report after this message, if it changed it. */
  observe(message: unknown): AgentContextUsage | undefined {
    const value = record(message);
    if (!value) return undefined;
    if (value.type === "stream_event" && !value.parent_tool_use_id) {
      const event = record(value.event);
      if (event?.type === "message_start")
        this.model = text(record(event.message)?.model) ?? this.model;
    }
    const request = this.requests.observe(message);
    if (request)
      return this.report({
        inputTokens: request.inputTokens,
        ...this.window(),
      });
    if (value.type === "system" && value.subtype === "compact_boundary") {
      const metadata = record(value.compact_metadata);
      const post = count(metadata?.post_tokens);
      const pre = count(metadata?.pre_tokens);
      return this.report({
        ...(post !== undefined ? { inputTokens: post } : {}),
        ...this.window(),
        compaction: {
          trigger: metadata?.trigger === "manual" ? "manual" : "auto",
          ...(pre !== undefined ? { preTokens: pre } : {}),
        },
      });
    }
    if (value.type !== "result") return undefined;
    this.observeCost(value);
    const usage = record(value.modelUsage);
    for (const [model, entry] of Object.entries(usage ?? {})) {
      const window = count(record(entry)?.contextWindow);
      if (window) claudeContextWindows.set(model, window);
    }
    // The first result tells the window of a request already reported.
    const last = this.reported;
    if (!last || last.compaction || last.inputTokens === undefined)
      return undefined;
    return this.report({ inputTokens: last.inputTokens, ...this.window() });
  }

  /** What a result observed earlier cost, when known. */
  costOf(message: unknown): number | undefined {
    const value = record(message);
    return value ? this.costs.get(value) : undefined;
  }

  private observeCost(result: Record<string, unknown>): void {
    const total =
      typeof result.total_cost_usd === "number" &&
      Number.isFinite(result.total_cost_usd)
        ? result.total_cost_usd
        : undefined;
    if (total === undefined) return;
    if (this.costTotal !== undefined && total >= this.costTotal)
      this.costs.set(result, total - this.costTotal);
    this.costTotal = total;
  }

  private window(): Pick<AgentContextUsage, "contextWindow" | "model"> {
    const window = this.model
      ? claudeContextWindows.get(this.model)
      : undefined;
    return {
      ...(window ? { contextWindow: window } : {}),
      ...(this.model ? { model: this.model } : {}),
    };
  }

  private report(context: AgentContextUsage): AgentContextUsage | undefined {
    if (sameContext(this.reported, context)) return undefined;
    this.reported = context;
    return context;
  }
}

/** Where Codex keeps its sessions for a process with this environment. */
export function codexHome(env: NodeJS.ProcessEnv): string {
  return (
    env.CODEX_HOME?.trim() || resolve(env.HOME?.trim() || homedir(), ".codex")
  );
}

/** Rollout paths found, by Codex thread id. */
const codexRollouts = new Map<string, string>();

/**
 * Follows the rollout log Codex keeps of a thread
 * (<CODEX_HOME>/sessions/…/rollout-…-<thread>.jsonl) for its `token_count`
 * records: the last request's input (cached included) and the model's
 * window. A turn reads what the log gained since it started.
 */
export class CodexContextFollower {
  private threadId?: string;
  private path?: string;
  private offset = 0;
  private rest = "";
  private model?: string;
  private turnTotal = -1;
  private reported?: AgentContextUsage;
  /** Input tokens the turn's requests read so far, as Codex totals them. */
  turnInputTokens = 0;

  constructor(private readonly homes: string[]) {}

  /** Whether the thread's log was found. */
  get found(): boolean {
    return this.path !== undefined;
  }

  /** The thread to follow; a resumed one from what it gains from now on. */
  async follow(threadId: string, options: { resumed: boolean }): Promise<void> {
    if (!threadId || threadId === this.threadId) return;
    this.threadId = threadId;
    this.path = undefined;
    this.offset = 0;
    this.rest = "";
    if (!options.resumed) return;
    const path = await this.logPath();
    try {
      if (path) this.offset = (await stat(path)).size;
    } catch {
      // A log that is gone is read from its start if it comes back.
    }
  }

  /** What the log gained since the last read: the context reports to make. */
  async read(): Promise<AgentContextUsage[]> {
    const path = await this.logPath();
    if (!path) return [];
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return [];
    }
    if (size <= this.offset) return [];
    const handle = await open(path, "r");
    let chunk: string;
    try {
      const buffer = Buffer.alloc(size - this.offset);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        this.offset,
      );
      this.offset += bytesRead;
      chunk = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    const lines = (this.rest + chunk).split("\n");
    this.rest = lines.pop() ?? "";
    const reports: AgentContextUsage[] = [];
    for (const line of lines) {
      const report = this.line(line);
      if (report) reports.push(report);
    }
    return reports;
  }

  private line(line: string): AgentContextUsage | undefined {
    if (
      !line.includes('"token_count"') &&
      !line.includes('"turn_context"') &&
      !line.includes('"compacted"')
    )
      return undefined;
    let entry: Record<string, unknown> | undefined;
    try {
      entry = record(JSON.parse(line));
    } catch {
      return undefined;
    }
    const payload = record(entry?.payload);
    if (!entry || !payload) return undefined;
    if (entry.type === "turn_context") {
      this.model = text(payload.model) ?? this.model;
      return undefined;
    }
    if (entry.type === "compacted")
      return this.report({
        ...(this.model ? { model: this.model } : {}),
        ...(this.reported?.contextWindow
          ? { contextWindow: this.reported.contextWindow }
          : {}),
        compaction: { trigger: "auto" },
      });
    if (entry.type !== "event_msg" || payload.type !== "token_count")
      return undefined;
    const info = record(payload.info);
    const total = record(info?.total_token_usage);
    const last = record(info?.last_token_usage);
    const input = count(last?.input_tokens);
    if (!info || !input) return undefined;
    // Codex repeats a request's count when only its rate limits change.
    const grown =
      (count(total?.input_tokens) ?? 0) + (count(total?.output_tokens) ?? 0);
    if (grown === this.turnTotal) return undefined;
    this.turnTotal = grown;
    this.turnInputTokens = count(total?.input_tokens) ?? 0;
    const window = count(info.model_context_window);
    return this.report({
      inputTokens: input,
      ...(window ? { contextWindow: window } : {}),
      ...(this.model ? { model: this.model } : {}),
    });
  }

  private report(context: AgentContextUsage): AgentContextUsage | undefined {
    if (sameContext(this.reported, context)) return undefined;
    this.reported = context;
    return context;
  }

  private async logPath(): Promise<string | undefined> {
    if (this.path || !this.threadId) return this.path;
    const known = codexRollouts.get(this.threadId);
    this.path =
      known ?? (await findSessionLog("codex", this.threadId, this.homes));
    if (this.path) codexRollouts.set(this.threadId, this.path);
    return this.path;
  }
}
