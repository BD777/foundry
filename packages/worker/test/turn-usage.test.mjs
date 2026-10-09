import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleActiveClaudeMessage } from "../dist/runner.js";
import {
  addTurnUsage,
  claudeResultUsage,
  codexTurnUsage,
} from "../dist/turn-usage.js";

// Shapes recorded from real Claude Agent SDK 0.3.201 / Codex CLI turns.
const claudeResult = (text, usage, extra = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: text,
  num_turns: 7,
  duration_ms: 20162,
  total_cost_usd: 0.0727868,
  usage: {
    input_tokens: 4,
    output_tokens: 1886,
    cache_read_input_tokens: 53574,
    cache_creation_input_tokens: 3042,
    ...usage,
  },
  ...extra,
});

test("Claude cache reads and writes are parts of the prompt total", () => {
  assert.deepEqual(claudeResultUsage(claudeResult("done")), {
    inputTokens: 4 + 53574 + 3042,
    cacheReadTokens: 53574,
    cacheWriteTokens: 3042,
    outputTokens: 1886,
    modelRequests: 7,
  });
  assert.equal(claudeResultUsage({ type: "assistant", usage: {} }), undefined);
  assert.equal(claudeResultUsage({ type: "result" }), undefined);
});

test("Codex input already includes its cached tokens", () => {
  assert.deepEqual(
    codexTurnUsage({
      type: "turn.completed",
      usage: {
        input_tokens: 28887,
        cached_input_tokens: 27264,
        cache_write_input_tokens: 0,
        output_tokens: 1291,
        reasoning_output_tokens: 229,
      },
    }),
    {
      inputTokens: 28887,
      cacheReadTokens: 27264,
      cacheWriteTokens: 0,
      outputTokens: 1291,
      reasoningTokens: 229,
    },
  );
  assert.equal(codexTurnUsage({ type: "turn.completed" }), undefined);
});

test("usage adds up across results without inventing absent fields", () => {
  const codex = codexTurnUsage({
    usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 },
  });
  const sum = addTurnUsage(codex, codex);
  assert.equal(sum.inputTokens, 20);
  assert.equal(sum.reasoningTokens, 0);
  assert.equal("modelRequests" in sum, false);
});

test("a turn that waits for background work reports the usage of every result it waited through", async () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-turn-usage-"));
  const messagesPath = join(directory, "messages.jsonl");
  writeFileSync(messagesPath, "");
  const events = [];
  const turn = {
    emit: async (label, detail, level, metadata) =>
      events.push({ label, metadata }),
    finalResult: "",
    messagesPath,
    nativeSessionId: "native_test",
    openTaskIds: new Set(),
    // Issue runs and agent-created sessions are judged on their final answer.
    waitForBackgroundTasks: true,
    partialResult: "",
    reject: (error) => {
      throw error;
    },
    resolve: () => undefined,
    resultPath: join(directory, "result.md"),
    startedAt: Date.now() - 5000,
    watchdog: {
      close: () => undefined,
      pause: () => undefined,
      touch: () => undefined,
    },
  };
  const runtime = {
    closed: false,
    input: { close: () => undefined },
    key: "runtime_test",
    lastUsed: 0,
    nativeSessionId: "native_test",
    pending: turn,
  };
  try {
    await handleActiveClaudeMessage(runtime, {
      type: "system",
      subtype: "task_started",
      task_id: "task_a",
    });
    await handleActiveClaudeMessage(runtime, claudeResult("waiting"));
    await handleActiveClaudeMessage(runtime, {
      type: "system",
      subtype: "task_notification",
      task_id: "task_a",
      status: "completed",
    });
    await handleActiveClaudeMessage(
      runtime,
      claudeResult("final", { output_tokens: 14 }, { num_turns: 1 }),
    );
    const finished = events.find(
      ({ label }) => label === "Claude Agent SDK finished",
    );
    const usage = finished?.metadata?.turnUsage;
    assert.ok(usage, "the finishing event carries the turn usage");
    assert.equal(usage.outputTokens, 1886 + 14);
    assert.equal(usage.modelRequests, 8);
    assert.equal(usage.cacheReadTokens, 2 * 53574);
    assert.ok(usage.durationMs >= 5000 && usage.durationMs < 60000);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a chat turn ends with its answer and reports that answer's usage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-turn-usage-"));
  const messagesPath = join(directory, "messages.jsonl");
  writeFileSync(messagesPath, "");
  const events = [];
  const turn = {
    emit: async (label, detail, level, metadata) =>
      events.push({ label, metadata }),
    finalResult: "",
    messagesPath,
    nativeSessionId: "native_test",
    openTaskIds: new Set(),
    partialResult: "",
    reject: (error) => {
      throw error;
    },
    resolve: () => undefined,
    resultPath: join(directory, "result.md"),
    startedAt: Date.now() - 5000,
    watchdog: {
      close: () => undefined,
      pause: () => undefined,
      touch: () => undefined,
    },
  };
  const runtime = {
    closed: false,
    input: { close: () => undefined },
    key: "runtime_test",
    lastUsed: 0,
    nativeSessionId: "native_test",
    pending: turn,
  };
  try {
    await handleActiveClaudeMessage(runtime, {
      type: "system",
      subtype: "task_started",
      task_id: "task_a",
    });
    await handleActiveClaudeMessage(runtime, claudeResult("waiting"));
    const finished = events.find(
      ({ label }) => label === "Claude Agent SDK finished",
    );
    const usage = finished?.metadata?.turnUsage;
    assert.ok(usage, "the answer ends the turn while its task runs on");
    assert.equal(usage.outputTokens, 1886);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
