import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeActiveClaudeRuntime } from "../dist/session/runner/active-runtimes.js";
import { handleActiveClaudeMessage } from "../dist/session/runner/claude-messages.js";
import { runCodexStreamedTurn } from "../dist/session/runner/codex-stream.js";
import {
  AgentSessionCanceledError,
  cancelActiveSession,
  isAgentSessionCanceledError,
} from "../dist/session/session-control.js";
import { ClaudeContextTracker } from "../dist/session/usage/context-usage.js";
import {
  addTurnUsage,
  ClaudeRequestUsageTracker,
  claudeResultUsage,
  codexTurnUsage,
} from "../dist/session/usage/turn-usage.js";

const stream = (event) => ({
  type: "stream_event",
  parent_tool_use_id: null,
  event,
});

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

test("Claude result timing becomes model time and time to first token", () => {
  const usage = claudeResultUsage(
    claudeResult(
      "done",
      {},
      {
        duration_api_ms: 8_400,
        ttft_ms: 620,
        ttft_stream_ms: 700,
        time_to_request_ms: 15,
      },
    ),
  );
  assert.equal(usage?.modelMs, 8_400);
  assert.equal(usage?.ttftMs, 700);

  const streamTiming = claudeResultUsage(
    claudeResult("done", {}, { duration_api_ms: 3_200, ttft_ms: 480 }),
  );
  assert.equal(streamTiming?.modelMs, 3_200);
  assert.equal(streamTiming?.ttftMs, 480);
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

test("unreliable estimated Codex timings do not reach the turn speed", () => {
  const turn = (modelMs, outputTokens) =>
    codexTurnUsage({
      usage: { input_tokens: 100, output_tokens: outputTokens },
      timing: { modelMs, timingEstimated: true },
    });

  assert.equal(turn(500, 1_000)?.modelMs, undefined);
  assert.equal(turn(1_000, 2_000)?.modelMs, undefined);
  assert.equal(turn(4_000, 100)?.modelMs, 4_000);
  assert.equal(
    codexTurnUsage({
      usage: { input_tokens: 100, output_tokens: 1_000 },
      timing: { modelMs: 500 },
    })?.modelMs,
    500,
  );
});

test("usage adds up across results without inventing absent fields", () => {
  const codex = codexTurnUsage({
    usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 },
  });
  const sum = addTurnUsage(codex, codex);
  assert.equal(sum.inputTokens, 20);
  assert.equal(sum.reasoningTokens, 0);
  assert.equal("modelRequests" in sum, false);

  const first = claudeResultUsage(
    claudeResult("first", {}, { duration_api_ms: 1_200, ttft_stream_ms: 300 }),
  );
  const next = claudeResultUsage(
    claudeResult("next", {}, { duration_api_ms: 800, ttft_stream_ms: 500 }),
  );
  assert.ok(first && next);
  const timed = addTurnUsage(first, next);
  assert.equal(timed.modelMs, 2_000);
  assert.equal(timed.ttftMs, 300);
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
    liveness: { observe: () => [], close: () => undefined },
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
    liveness: { observe: () => [], close: () => undefined },
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

test("a Claude error result emits failed usage with tokens and the serving model", async () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-turn-usage-error-"));
  writeFileSync(join(directory, "messages.jsonl"), "");
  const events = [];
  const rejected = [];
  const turn = {
    emit: async (label, detail, level, metadata) =>
      events.push({ label, detail, metadata }),
    finalResult: "",
    messagesPath: join(directory, "messages.jsonl"),
    nativeSessionId: "native_test",
    openTaskIds: new Set(),
    partialResult: "",
    reject: (error) => rejected.push(error),
    requestUsage: new ClaudeRequestUsageTracker(),
    resolve: () => undefined,
    resultPath: join(directory, "result.md"),
    startedAt: Date.now() - 2000,
    liveness: { observe: () => [], close: () => undefined },
  };
  const runtime = {
    closed: false,
    context: new ClaudeContextTracker({ resumed: false }),
    input: { close: () => undefined },
    key: "runtime_usage_error",
    lastUsed: 0,
    nativeSessionId: "native_test",
    pending: turn,
  };
  try {
    await handleActiveClaudeMessage(
      runtime,
      stream({
        type: "message_start",
        message: {
          id: "msg_failed",
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      }),
    );
    await handleActiveClaudeMessage(
      runtime,
      claudeResult(
        "provider rejected the turn",
        { input_tokens: 5, output_tokens: 17 },
        {
          subtype: "error_during_execution",
          is_error: true,
          result: "provider rejected the turn",
          total_cost_usd: 0.125,
          duration_api_ms: 4200,
          ttft_ms: 250,
        },
      ),
    );
    const usage = events.find(
      ({ metadata }) => metadata?.turnUsage?.outcome === "failed",
    )?.metadata?.turnUsage;
    assert.ok(usage, "the failure emits turn usage");
    assert.equal(usage.model, "claude-sonnet-4-5");
    assert.equal(usage.inputTokens, 5 + 53574 + 3042);
    assert.equal(usage.outputTokens, 17);
    assert.equal(usage.modelMs, 4200);
    assert.equal(usage.ttftMs, 250);
    assert.equal(usage.costUsd, 0.125);
    assert.ok(usage.durationMs >= 2000);
    assert.equal(rejected.length, 1);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a canceled Claude turn emits canceled usage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-turn-usage-cancel-"));
  writeFileSync(join(directory, "messages.jsonl"), "");
  const events = [];
  const turn = {
    emit: async (label, detail, level, metadata) =>
      events.push({ label, detail, metadata }),
    finalResult: "",
    messagesPath: join(directory, "messages.jsonl"),
    nativeSessionId: "native_test",
    openTaskIds: new Set(),
    partialResult: "",
    reject: () => undefined,
    resolve: () => undefined,
    resultPath: join(directory, "result.md"),
    startedAt: Date.now() - 1000,
    usage: {
      inputTokens: 21,
      cacheReadTokens: 11,
      cacheWriteTokens: 2,
      outputTokens: 7,
      model: "claude-opus-4-5",
      modelRequests: 1,
    },
    liveness: { observe: () => [], close: () => undefined },
  };
  const runtime = {
    closed: false,
    input: { close: () => undefined },
    key: "runtime_usage_cancel",
    lastUsed: 0,
    nativeSessionId: "native_test",
    pending: turn,
  };
  try {
    closeActiveClaudeRuntime(runtime, new AgentSessionCanceledError());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const usage = events.find(
      ({ metadata }) => metadata?.turnUsage?.outcome === "canceled",
    )?.metadata?.turnUsage;
    assert.ok(usage, "cancellation emits turn usage");
    assert.equal(usage.inputTokens, 21);
    assert.equal(usage.outputTokens, 7);
    assert.equal(usage.model, "claude-opus-4-5");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a failed Codex turn emits failed usage with timing and model", async () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-codex-usage-error-"));
  writeFileSync(join(directory, "events.jsonl"), "");
  const events = [];
  const state = {
    emit: async (label, detail, level, metadata) =>
      events.push({ label, detail, level, metadata }),
    eventsPath: join(directory, "events.jsonl"),
    files: { recordToolWrite: async () => undefined },
    finalResult: "",
    nativeSessionId: "",
    reportNativeSessionId: () => undefined,
    startedAt: Date.now() - 3000,
    context: {
      currentModel: "gpt-5.5-codex",
      found: false,
      turnInputTokens: 0,
    },
    thread: {},
  };
  const thread = {
    runStreamed: async () => ({
      events: (async function* () {
        yield {
          type: "turn.failed",
          error: { message: "native upstream failed" },
          usage: {
            input_tokens: 240,
            cached_input_tokens: 180,
            cache_write_input_tokens: 3,
            output_tokens: 27,
            reasoning_output_tokens: 9,
          },
          timing: {
            modelMs: 1800,
            ttftMs: 320,
            timingEstimated: true,
          },
        };
      })(),
    }),
  };
  try {
    await assert.rejects(
      runCodexStreamedTurn(state, thread, "go", `sess_${randomUUID()}`),
      /native upstream failed/,
    );
    const usage = events.find(
      ({ metadata }) => metadata?.turnUsage?.outcome === "failed",
    )?.metadata?.turnUsage;
    assert.ok(usage, "the failure emits turn usage");
    assert.equal(usage.model, "gpt-5.5-codex");
    assert.equal(usage.inputTokens, 240);
    assert.equal(usage.cacheReadTokens, 180);
    assert.equal(usage.outputTokens, 27);
    assert.equal(usage.reasoningTokens, 9);
    assert.equal(usage.modelMs, 1800);
    assert.equal(usage.ttftMs, 320);
    assert.equal(usage.timingEstimated, true);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Codex request usage takes its model from the turn context", async () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-codex-request-usage-"));
  writeFileSync(join(directory, "events.jsonl"), "");
  const events = [];
  const state = {
    emit: async (label, detail, level, metadata) =>
      events.push({ label, detail, level, metadata }),
    eventsPath: join(directory, "events.jsonl"),
    files: { recordToolWrite: async () => undefined },
    finalResult: "",
    nativeSessionId: "",
    reportNativeSessionId: () => undefined,
    startedAt: Date.now() - 3000,
    context: {
      currentModel: "gpt-5.5-codex",
      found: true,
      turnInputTokens: 10,
      read: async () => [],
    },
    thread: {},
  };
  const thread = {
    runStreamed: async () => ({
      events: (async function* () {
        yield {
          type: "foundry.model_request_usage",
          requestUsage: {
            requestId: "turn-1:1",
            inputTokens: 10,
            cacheReadTokens: 3,
            cacheWriteTokens: 1,
            outputTokens: 4,
            requestMs: 250,
            timingEstimated: true,
          },
        };
        yield {
          type: "turn.completed",
          usage: {
            input_tokens: 10,
            cached_input_tokens: 3,
            cache_write_input_tokens: 1,
            output_tokens: 4,
          },
        };
      })(),
    }),
  };
  try {
    await runCodexStreamedTurn(state, thread, "go", `sess_${randomUUID()}`);
    const request = events.find(
      ({ metadata }) => metadata?.requestUsage?.requestId === "turn-1:1",
    )?.metadata?.requestUsage;
    assert.ok(request);
    assert.equal(request.model, "gpt-5.5-codex");
    assert.equal(request.requestMs, 250);
    assert.equal(request.timingEstimated, true);
    assert.equal(request.firstTokenMs, undefined);
    assert.equal(request.generationMs, undefined);
    assert.equal(state.usage.model, "gpt-5.5-codex");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a canceled Codex turn emits canceled usage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-codex-usage-cancel-"));
  writeFileSync(join(directory, "events.jsonl"), "");
  const events = [];
  const sessionId = `sess_${randomUUID()}`;
  const state = {
    inputId: "input_cancel",
    emit: async (label, detail, level, metadata) =>
      events.push({ label, detail, level, metadata }),
    eventsPath: join(directory, "events.jsonl"),
    files: { recordToolWrite: async () => undefined },
    finalResult: "",
    nativeSessionId: "",
    reportNativeSessionId: () => undefined,
    startedAt: Date.now() - 1500,
    context: {
      currentModel: "gpt-5.5-codex",
      found: false,
      turnInputTokens: 0,
    },
    thread: {},
  };
  const thread = {
    runStreamed: async (_input, options) => ({
      events: (async function* () {
        await new Promise((_, reject) => {
          const fail = () =>
            reject(
              Object.assign(new Error("aborted"), {
                usage: {
                  input_tokens: 80,
                  cached_input_tokens: 60,
                  output_tokens: 4,
                },
                timing: {
                  modelMs: 900,
                  ttftMs: 120,
                  timingEstimated: true,
                },
              }),
            );
          if (options.signal.aborted) fail();
          else
            options.signal.addEventListener("abort", fail, {
              once: true,
            });
        });
      })(),
    }),
  };
  try {
    const running = runCodexStreamedTurn(state, thread, "go", sessionId);
    await cancelActiveSession(sessionId, "input_cancel");
    await assert.rejects(running, (error) =>
      isAgentSessionCanceledError(error),
    );
    const usage = events.find(
      ({ metadata }) => metadata?.turnUsage?.outcome === "canceled",
    )?.metadata?.turnUsage;
    assert.ok(usage, "cancellation emits turn usage");
    assert.equal(usage.inputTokens, 80);
    assert.equal(usage.outputTokens, 4);
    assert.equal(usage.model, "gpt-5.5-codex");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
