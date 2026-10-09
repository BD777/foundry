import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeNativeUsage,
  codexNativeUsage,
  readNativeSessionUsage,
} from "../dist/native-usage.js";
import { nativeChatTranscript } from "../dist/native-chat-transcript.js";

// Shapes mirror Claude Code's session log: one request's content blocks
// arrive as separate records with the same id, the first ones with zeros.
const usage = (input, read, write, output) => ({
  input_tokens: input,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  output_tokens: output,
});
const prompt = (at, text) => ({
  type: "user",
  timestamp: at,
  message: { role: "user", content: text },
});
const assistant = (at, id, content, tokens) => ({
  type: "assistant",
  timestamp: at,
  message: { id, role: "assistant", content, usage: tokens },
});
const toolResult = (at) => ({
  type: "user",
  timestamp: at,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
  },
});
const claudeLog = [
  prompt("2026-10-01T10:00:00.000Z", "first"),
  assistant(
    "2026-10-01T10:00:01.000Z",
    "msg_a",
    [{ type: "thinking", thinking: "plan" }],
    usage(0, 0, 0, 0),
  ),
  assistant(
    "2026-10-01T10:00:02.000Z",
    "msg_a",
    [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }],
    usage(10, 100, 20, 50),
  ),
  toolResult("2026-10-01T10:00:03.000Z"),
  // A subagent's request is its own, not the turn's.
  {
    ...assistant(
      "2026-10-01T10:00:03.500Z",
      "msg_side",
      [],
      usage(999, 0, 0, 999),
    ),
    isSidechain: true,
  },
  assistant(
    "2026-10-01T10:00:04.000Z",
    "msg_b",
    [{ type: "text", text: "done" }],
    usage(5, 130, 0, 7),
  ),
  {
    type: "system",
    subtype: "turn_duration",
    durationMs: 4200,
    timestamp: "2026-10-01T10:00:04.100Z",
  },
  {
    type: "user",
    isMeta: true,
    timestamp: "2026-10-01T10:01:00.000Z",
    message: { role: "user", content: "<meta>" },
  },
  prompt("2026-10-01T10:02:00.000Z", "second"),
  assistant(
    "2026-10-01T10:02:05.000Z",
    "msg_c",
    [{ type: "text", text: "again" }],
    usage(1, 200, 0, 3),
  ),
];

test("Claude turns count each request once and skip tool results, meta and subagents", () => {
  const { turns, requests } = claudeNativeUsage(claudeLog);
  assert.equal(turns.length, 2);
  assert.deepEqual(
    { ...turns[0], startedAt: undefined, endedAt: undefined },
    {
      inputTokens: 10 + 100 + 20 + 5 + 130,
      cacheReadTokens: 230,
      cacheWriteTokens: 20,
      outputTokens: 57,
      modelRequests: 2,
      durationMs: 4200,
      startedAt: undefined,
      endedAt: undefined,
    },
  );
  assert.equal(turns[1].outputTokens, 3);
  assert.equal(turns[1].durationMs, 5000, "measured when no turn_duration");
  const toolRequest = requests.find((request) =>
    request.toolUseIds.includes("toolu_1"),
  );
  assert.equal(toolRequest.usage.requestId, "msg_a");
  assert.equal(toolRequest.usage.outputTokens, 50, "the largest report counts");
});

// Shapes mirror a Codex rollout: token_count after each model call, repeated
// counts without new tokens, turns between task_started and task_complete.
const codexEvent = (at, payload) => ({
  type: "event_msg",
  timestamp: at,
  payload,
});
const tokenCount = (at, total, last) =>
  codexEvent(at, {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: total[0],
        cached_input_tokens: total[1],
        output_tokens: total[2],
        reasoning_output_tokens: total[3],
      },
      last_token_usage: {
        input_tokens: last[0],
        cached_input_tokens: last[1],
        output_tokens: last[2],
        reasoning_output_tokens: last[3],
      },
    },
  });
const codexLog = [
  codexEvent("2026-10-01T10:00:00.000Z", {
    type: "task_started",
    turn_id: "t1",
  }),
  codexEvent("2026-10-01T10:00:00.100Z", { type: "token_count", info: null }),
  {
    type: "response_item",
    timestamp: "2026-10-01T10:00:01.000Z",
    payload: {
      type: "function_call",
      id: "fc1",
      call_id: "call_1",
      name: "shell",
      arguments: "{}",
    },
  },
  tokenCount("2026-10-01T10:00:02.000Z", [100, 50, 10, 2], [100, 50, 10, 2]),
  tokenCount("2026-10-01T10:00:02.050Z", [100, 50, 10, 2], [100, 50, 10, 2]),
  {
    type: "response_item",
    timestamp: "2026-10-01T10:00:03.000Z",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "answer one" }],
    },
  },
  tokenCount("2026-10-01T10:00:04.000Z", [250, 140, 30, 5], [150, 90, 20, 3]),
  codexEvent("2026-10-01T10:00:05.000Z", { type: "task_complete" }),
  codexEvent("2026-10-01T10:05:00.000Z", {
    type: "task_started",
    turn_id: "t2",
  }),
  tokenCount("2026-10-01T10:05:02.000Z", [400, 240, 31, 5], [150, 100, 1, 0]),
  codexEvent("2026-10-01T10:05:03.000Z", { type: "turn_aborted" }),
];

test("Codex turns are what the running total grew by, repeated counts once", () => {
  const { turns } = codexNativeUsage(codexLog);
  assert.equal(turns.length, 2);
  assert.deepEqual(
    { ...turns[0], startedAt: undefined, endedAt: undefined },
    {
      inputTokens: 250,
      cacheReadTokens: 140,
      cacheWriteTokens: 0,
      outputTokens: 30,
      reasoningTokens: 5,
      modelRequests: 2,
      durationMs: 5000,
      startedAt: undefined,
      endedAt: undefined,
    },
  );
  assert.equal(turns[1].inputTokens, 150);
  assert.equal(turns[1].modelRequests, 1);
});

test("imported chats carry step and turn usage like live ones", () => {
  const claude = nativeChatTranscript(
    claudeLog.map((entry) => JSON.stringify(entry)),
    "claude",
  );
  const tool = claude.find((message) => message.kind === "tool");
  assert.equal(tool.requestUsage.requestId, "msg_a");
  const answers = claude.filter((message) => message.kind === "assistant");
  assert.equal(answers.at(-2).turnUsage.outputTokens, 57);
  assert.equal(answers.at(-1).turnUsage.outputTokens, 3);
  assert.equal(answers.at(-1).turnUsage.startedAt, undefined);

  const codex = nativeChatTranscript(
    codexLog.map((entry) => JSON.stringify(entry)),
    "codex",
  );
  const call = codex.find((message) => message.kind === "tool");
  assert.equal(call.requestUsage.inputTokens, 100);
  const answer = codex.find((message) => message.kind === "assistant");
  assert.equal(answer.requestUsage.inputTokens, 150);
  assert.equal(answer.turnUsage.inputTokens, 250);
});

test("a session's usage is read from its log on the device", async () => {
  const home = mkdtempSync(join(tmpdir(), "native-usage-"));
  const id = "0b7f2c3e-1111-4222-8333-444455556666";
  mkdirSync(join(home, "projects", "-work-repo"), { recursive: true });
  writeFileSync(
    join(home, "projects", "-work-repo", `${id}.jsonl`),
    claudeLog.map((entry) => JSON.stringify(entry)).join("\n"),
  );
  const usage = await readNativeSessionUsage("claude", id, [home]);
  assert.equal(usage.turns.length, 2);
  assert.equal(
    await readNativeSessionUsage(
      "claude",
      "0b7f2c3e-0000-0000-0000-000000000000",
      [home],
    ),
    undefined,
  );
  assert.equal(
    await readNativeSessionUsage("claude", "../../etc/passwd", [home]),
    undefined,
  );
});
