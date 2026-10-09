/**
 * Token usage read back from the logs Claude Code and Codex keep of their own
 * sessions, for turns Foundry ran before it recorded usage and for chats
 * imported from the device. The rules match the live ones (turn-usage.ts):
 * Claude counts each model request once, its prompt total including cache
 * reads and writes; Codex counts what its running total grew by in a turn.
 */
import type {
  AgentTurnUsage,
  ModelRequestUsage,
} from "@bd777/foundry-protocol";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { claudeRequestUsage } from "./turn-usage.js";

/** One native turn: from a person's prompt to the next one. */
export interface NativeTurnUsage extends AgentTurnUsage {
  startedAt: string;
  endedAt: string;
}

/** One Claude model request and the tool calls it made. */
export interface NativeRequestUsage {
  usage: ModelRequestUsage;
  toolUseIds: string[];
}

export interface NativeSessionUsage {
  turns: NativeTurnUsage[];
  requests: NativeRequestUsage[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

function timestamp(value: unknown): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : "";
}

/** A prompt the person wrote: not a tool result, meta note or summary. */
function claudePrompt(entry: Record<string, unknown>): boolean {
  if (
    entry.type !== "user" ||
    entry.isMeta === true ||
    entry.isSidechain === true ||
    entry.isCompactSummary === true
  ) {
    return false;
  }
  const content = record(entry.message)?.content;
  if (typeof content === "string") return content.trim() !== "";
  return (
    Array.isArray(content) &&
    content.some((part) => {
      const type = record(part)?.type;
      return type === "text" || type === "image";
    }) &&
    !content.some((part) => record(part)?.type === "tool_result")
  );
}

/** Claude reports a request on every content block it produced; keep the largest. */
function mergeRequest(
  previous: ModelRequestUsage | undefined,
  next: ModelRequestUsage,
): ModelRequestUsage {
  if (!previous) return next;
  return {
    requestId: next.requestId,
    inputTokens: Math.max(previous.inputTokens, next.inputTokens),
    cacheReadTokens: Math.max(previous.cacheReadTokens, next.cacheReadTokens),
    cacheWriteTokens: Math.max(
      previous.cacheWriteTokens,
      next.cacheWriteTokens,
    ),
    outputTokens: Math.max(previous.outputTokens, next.outputTokens),
  };
}

interface OpenTurn {
  startedAt: string;
  endedAt: string;
  durationMs?: number;
}

function closeTurn(
  turn: OpenTurn,
  usage: Omit<AgentTurnUsage, "durationMs">,
): NativeTurnUsage {
  const measured = Date.parse(turn.endedAt) - Date.parse(turn.startedAt);
  return {
    ...usage,
    durationMs:
      turn.durationMs ??
      (Number.isFinite(measured) ? Math.max(0, measured) : 0),
    startedAt: turn.startedAt,
    endedAt: turn.endedAt || turn.startedAt,
  };
}

/**
 * Claude Code session records (~/.claude/projects/<project>/<id>.jsonl).
 * Subagent records (sidechains) are left out, as live turns leave them out.
 */
export function claudeNativeUsage(entries: unknown[]): NativeSessionUsage {
  const turns: NativeTurnUsage[] = [];
  const requests = new Map<string, NativeRequestUsage>();
  let turn: OpenTurn | undefined;
  let turnRequests: string[] = [];
  const close = () => {
    if (!turn || turnRequests.length === 0) return;
    const usage = {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    };
    for (const id of new Set(turnRequests)) {
      const request = requests.get(id)?.usage;
      if (!request) continue;
      usage.inputTokens += request.inputTokens;
      usage.cacheReadTokens += request.cacheReadTokens;
      usage.cacheWriteTokens += request.cacheWriteTokens;
      usage.outputTokens += request.outputTokens;
    }
    turns.push(
      closeTurn(turn, { ...usage, modelRequests: new Set(turnRequests).size }),
    );
  };
  for (const value of entries) {
    const entry = record(value);
    if (!entry) continue;
    const at = timestamp(entry.timestamp);
    if (claudePrompt(entry)) {
      close();
      turn = { startedAt: at, endedAt: at };
      turnRequests = [];
      continue;
    }
    if (!turn || entry.isSidechain === true) continue;
    if (entry.type === "system" && entry.subtype === "turn_duration") {
      if (count(entry.durationMs) > 0)
        turn.durationMs = count(entry.durationMs);
      continue;
    }
    if (entry.type !== "assistant") continue;
    const usage = claudeRequestUsage(entry);
    if (!usage) continue;
    const existing = requests.get(usage.requestId);
    const content = record(entry.message)?.content;
    const toolUseIds = Array.isArray(content)
      ? content
          .map(record)
          .filter(
            (part) => part?.type === "tool_use" && typeof part.id === "string",
          )
          .map((part) => part!.id as string)
      : [];
    requests.set(usage.requestId, {
      usage: mergeRequest(existing?.usage, usage),
      toolUseIds: [...(existing?.toolUseIds ?? []), ...toolUseIds],
    });
    turnRequests.push(usage.requestId);
    if (at) turn.endedAt = at;
  }
  close();
  return { turns, requests: [...requests.values()] };
}

interface CodexTotals {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

function codexTotals(value: unknown): CodexTotals | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  return {
    input: count(usage.input_tokens),
    cached: count(usage.cached_input_tokens),
    cacheWrite: count(usage.cache_write_input_tokens),
    output: count(usage.output_tokens),
    reasoning: count(usage.reasoning_output_tokens),
  };
}

const zeroTotals: CodexTotals = {
  input: 0,
  cached: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
};

/**
 * Codex rollout records (~/.codex/sessions/.../rollout-*.jsonl). A turn runs
 * from `task_started` to `task_complete` or `turn_aborted`; its usage is how
 * far `total_token_usage` grew, so repeated `token_count` events count once.
 */
export function codexNativeUsage(entries: unknown[]): NativeSessionUsage {
  const turns: NativeTurnUsage[] = [];
  let total: CodexTotals = zeroTotals;
  let turn: (OpenTurn & { from: CodexTotals; requests: number }) | undefined;
  const close = (at: string) => {
    if (!turn) return;
    if (at) turn.endedAt = at;
    const grown = (key: keyof CodexTotals) =>
      Math.max(0, total[key] - turn!.from[key]);
    if (turn.requests > 0) {
      turns.push(
        closeTurn(turn, {
          inputTokens: grown("input"),
          cacheReadTokens: grown("cached"),
          cacheWriteTokens: grown("cacheWrite"),
          outputTokens: grown("output"),
          reasoningTokens: grown("reasoning"),
          modelRequests: turn.requests,
        }),
      );
    }
    turn = undefined;
  };
  for (const value of entries) {
    const entry = record(value);
    const payload = record(entry?.payload);
    if (!entry || entry.type !== "event_msg" || !payload) continue;
    const at = timestamp(entry.timestamp);
    if (payload.type === "task_started") {
      close("");
      turn = { startedAt: at, endedAt: at, from: total, requests: 0 };
    } else if (payload.type === "token_count") {
      const next = codexTotals(record(payload.info)?.total_token_usage);
      if (!next || next.input + next.output === total.input + total.output)
        continue;
      total = next;
      if (turn) {
        turn.requests += 1;
        turn.endedAt = at;
      }
    } else if (
      payload.type === "task_complete" ||
      payload.type === "turn_aborted"
    ) {
      close(at);
    }
  }
  close("");
  return { turns, requests: [] };
}

/** Where a native session's log is, if this device has it. */
export async function findSessionLog(
  provider: "claude" | "codex",
  nativeSessionId: string,
  homes: string[],
): Promise<string | undefined> {
  if (!/^[\w-]{8,}$/.test(nativeSessionId)) return undefined;
  for (const home of homes) {
    if (provider === "claude") {
      const projects = resolve(home, "projects");
      let dirs: string[] = [];
      try {
        dirs = await readdir(projects);
      } catch {
        continue;
      }
      for (const dir of dirs) {
        const candidate = resolve(projects, dir, `${nativeSessionId}.jsonl`);
        try {
          if ((await stat(candidate)).isFile()) return candidate;
        } catch {
          continue;
        }
      }
      continue;
    }
    // Codex: sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<id>.jsonl
    const pending: { dir: string; depth: number }[] = [
      { dir: resolve(home, "sessions"), depth: 0 },
    ];
    while (pending.length) {
      const { dir, depth } = pending.pop()!;
      let names: string[] = [];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.endsWith(`${nativeSessionId}.jsonl`))
          return resolve(dir, name);
        if (depth < 3 && !name.endsWith(".jsonl"))
          pending.push({ dir: resolve(dir, name), depth: depth + 1 });
      }
    }
  }
  return undefined;
}

/** Only the records the usage rules read, so a large log stays cheap. */
const relevant: Record<"claude" | "codex", RegExp> = {
  claude: /"type":"(user|assistant)"|"turn_duration"/,
  codex: /"(token_count|task_started|task_complete|turn_aborted)"/,
};

/**
 * Reads a native session's log line by line and returns its usage, or
 * undefined when the device has no log for it.
 */
export async function readNativeSessionUsage(
  provider: "claude" | "codex",
  nativeSessionId: string,
  homes: string[],
): Promise<NativeSessionUsage | undefined> {
  const path = await findSessionLog(provider, nativeSessionId, homes);
  if (!path) return undefined;
  const entries: unknown[] = [];
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!relevant[provider].test(line)) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return provider === "claude"
    ? claudeNativeUsage(entries)
    : codexNativeUsage(entries);
}
