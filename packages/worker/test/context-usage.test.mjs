import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ClaudeContextTracker,
  CodexContextFollower,
  codexHome,
} from "../dist/context-usage.js";
import { handleActiveClaudeMessage } from "../dist/runner.js";
import { addTurnUsage, claudeResultUsage } from "../dist/turn-usage.js";

const stream = (event, parent = null) => ({
  type: "stream_event",
  parent_tool_use_id: parent,
  event,
});

/** One main-agent request as Claude Agent SDK 0.3.201 streams it. */
function request(id, model, usage) {
  return [
    stream({
      type: "message_start",
      message: { id, model, usage: { input_tokens: 0, output_tokens: 0 } },
    }),
    stream({ type: "message_delta", usage }),
    stream({ type: "message_stop" }),
  ];
}

const result = (model, totalCost, window = 1_000_000) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  num_turns: 1,
  total_cost_usd: totalCost,
  usage: { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 100 },
  modelUsage: {
    "claude-haiku-5-5": { contextWindow: 200_000, costUSD: 0.001 },
    [model]: { contextWindow: window, costUSD: totalCost },
  },
});

test("Claude reports each main request's whole input, and the window once a result names it", () => {
  const model = "claude-context-test-a";
  const tracker = new ClaudeContextTracker({ resumed: false });
  const reports = [
    ...request("msg_1", model, {
      input_tokens: 5,
      cache_read_input_tokens: 40_000,
      cache_creation_input_tokens: 1_000,
      output_tokens: 300,
    }),
    // A subagent's request is not the main context.
    stream(
      {
        type: "message_start",
        message: { id: "msg_sub", model: "claude-haiku-5-5", usage: {} },
      },
      "toolu_1",
    ),
    stream(
      { type: "message_delta", usage: { input_tokens: 9_999 } },
      "toolu_1",
    ),
    stream({ type: "message_stop" }, "toolu_1"),
  ]
    .map((message) => tracker.observe(message))
    .filter(Boolean);
  assert.deepEqual(reports, [{ inputTokens: 41_005, model }]);

  // The result names the window: the last request is reported again with it.
  assert.deepEqual(tracker.observe(result(model, 0.5)), {
    inputTokens: 41_005,
    contextWindow: 1_000_000,
    model,
  });
  // Later requests carry it; the same report twice is made once.
  const next = request("msg_2", model, {
    input_tokens: 3,
    cache_read_input_tokens: 42_000,
    output_tokens: 20,
  })
    .map((message) => tracker.observe(message))
    .filter(Boolean);
  assert.deepEqual(next, [
    { inputTokens: 42_003, contextWindow: 1_000_000, model },
  ]);
  assert.equal(tracker.observe(result(model, 0.75)), undefined);

  // A compaction is reported with what it left, when Claude says.
  assert.deepEqual(
    tracker.observe({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: {
        trigger: "auto",
        pre_tokens: 950_000,
        post_tokens: 31_000,
      },
    }),
    {
      inputTokens: 31_000,
      contextWindow: 1_000_000,
      model,
      compaction: { trigger: "auto", preTokens: 950_000, postTokens: 31_000 },
    },
  );
  assert.deepEqual(
    tracker.observe({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual" },
    }),
    { contextWindow: 1_000_000, model, compaction: { trigger: "manual" } },
  );
});

test("a result's cost is what Claude's running total grew by; unknown for a resumed process's first", () => {
  const model = "claude-context-test-b";
  const fresh = new ClaudeContextTracker({ resumed: false });
  const first = result(model, 0.25);
  const second = result(model, 0.75);
  fresh.observe(first);
  fresh.observe(second);
  assert.equal(fresh.costOf(first), 0.25);
  assert.equal(fresh.costOf(second), 0.5);

  const resumed = new ClaudeContextTracker({ resumed: true });
  const restored = result(model, 3);
  const after = result(model, 3.5);
  resumed.observe(restored);
  resumed.observe(after);
  assert.equal(resumed.costOf(restored), undefined);
  assert.equal(resumed.costOf(after), 0.5);

  assert.equal(claudeResultUsage(after, 0.5).costUsd, 0.5);
  assert.equal(claudeResultUsage(after).costUsd, undefined);
  const both = addTurnUsage(
    claudeResultUsage(first, 0.25),
    claudeResultUsage(after, 0.5),
  );
  assert.equal(both.costUsd, 0.75);
  // One result of unknown cost leaves the turn's cost unknown.
  assert.equal(
    addTurnUsage(claudeResultUsage(first, 0.25), claudeResultUsage(after))
      .costUsd,
    undefined,
  );
});

test("an active Claude runtime records the context and the turn's cost", async () => {
  const model = "claude-context-test-c";
  const directory = mkdtempSync(join(tmpdir(), "foundry-context-usage-"));
  const events = [];
  const resolved = [];
  const turn = {
    emit: async (label, detail, level, metadata) =>
      events.push({ label, detail, metadata }),
    finalResult: "",
    messagesPath: join(directory, "messages.jsonl"),
    nativeSessionId: "native_context",
    openTaskIds: new Set(),
    partialResult: "",
    reject: (error) => {
      throw error;
    },
    resolve: (value) => resolved.push(value),
    resultPath: join(directory, "result.md"),
    startedAt: Date.now() - 1000,
    liveness: { observe: () => [], close: () => undefined },
  };
  const runtime = {
    closed: false,
    key: "context_test",
    lastUsed: 0,
    nativeSessionId: "native_context",
    pending: turn,
    input: { close: () => undefined },
    context: new ClaudeContextTracker({ resumed: false }),
  };
  try {
    for (const message of request("msg_c1", model, {
      input_tokens: 10,
      cache_read_input_tokens: 90_000,
      output_tokens: 50,
    }))
      await handleActiveClaudeMessage(runtime, message);
    await handleActiveClaudeMessage(runtime, {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "msg_c1",
        model,
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 10, output_tokens: 50 },
      },
    });
    await handleActiveClaudeMessage(runtime, result(model, 0.4, 200_000));
    const context = events
      .filter((event) => event.metadata?.contextUsage)
      .map((event) => [event.label, event.metadata.contextUsage]);
    assert.deepEqual(context, [
      ["Model request usage", { inputTokens: 90_010, model }],
      [
        "Model request usage",
        { inputTokens: 90_010, contextWindow: 200_000, model },
      ],
    ]);
    const finished = events.find(
      (event) => event.label === "Claude Agent SDK finished",
    );
    assert.equal(finished.metadata.turnUsage.costUsd, 0.4);
    assert.equal(resolved.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const tokenCount = (last, total, window = 258_400) =>
  JSON.stringify({
    timestamp: "2026-10-11T08:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: total,
        last_token_usage: last,
        model_context_window: window,
      },
      rate_limits: {},
    },
  });

const usage = (input, cached, output) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: 0,
  total_tokens: input + output,
});

test("Codex's context comes from the token counts its rollout log gains", async () => {
  const home = mkdtempSync(join(tmpdir(), "foundry-codex-home-"));
  const threadId = "01a1244c-7601-78e2-8efe-c77a6cdffdbf";
  const day = join(home, "sessions", "2026", "10", "11");
  mkdirSync(day, { recursive: true });
  const log = join(day, `rollout-2026-10-11T08-00-00-${threadId}.jsonl`);
  // An earlier turn of the resumed thread is not reported again.
  writeFileSync(
    log,
    `${tokenCount(usage(9_000, 8_000, 10), usage(9_000, 8_000, 10))}\n`,
  );
  try {
    const follower = new CodexContextFollower([home]);
    await follower.follow(threadId, { resumed: true });
    assert.equal(follower.found, true);
    assert.deepEqual(await follower.read(), []);

    const turnContext = JSON.stringify({
      timestamp: "2026-10-11T08:00:01.000Z",
      type: "turn_context",
      payload: { cwd: "/repo", model: "gpt-5.5-codex" },
    });
    const first = tokenCount(
      usage(14_844, 12_032, 57),
      usage(14_844, 12_032, 57),
    );
    appendFileSync(log, `${turnContext}\n${first}\n`);
    // Codex repeats a count when only its rate limits change.
    appendFileSync(log, `${first}\n`);
    const second = tokenCount(
      usage(14_972, 14_720, 212),
      usage(29_816, 26_752, 269),
    );
    // A line still being written waits for its end.
    appendFileSync(log, second.slice(0, 40));
    assert.deepEqual(await follower.read(), [
      { inputTokens: 14_844, contextWindow: 258_400, model: "gpt-5.5-codex" },
    ]);
    appendFileSync(log, `${second.slice(40)}\n`);
    assert.deepEqual(await follower.read(), [
      { inputTokens: 14_972, contextWindow: 258_400, model: "gpt-5.5-codex" },
    ]);
    assert.equal(follower.turnInputTokens, 29_816);

    appendFileSync(
      log,
      `${JSON.stringify({ timestamp: "2026-10-11T08:00:09.000Z", type: "compacted", payload: { message: "", replacement_history: [] } })}\n`,
    );
    assert.deepEqual(await follower.read(), [
      {
        model: "gpt-5.5-codex",
        contextWindow: 258_400,
        compaction: { trigger: "auto" },
      },
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a new Codex thread is read from its start; a missing log reports nothing", async () => {
  const home = mkdtempSync(join(tmpdir(), "foundry-codex-home-"));
  try {
    const follower = new CodexContextFollower([home]);
    await follower.follow("01a12999-0000-7000-8000-000000000001", {
      resumed: false,
    });
    assert.deepEqual(await follower.read(), []);
    assert.equal(follower.found, false);
    const day = join(home, "sessions", "2026", "10", "11");
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(
        day,
        "rollout-2026-10-11T09-00-00-01a12999-0000-7000-8000-000000000001.jsonl",
      ),
      `${tokenCount(usage(100, 0, 5), usage(100, 0, 5), 400_000)}\n`,
    );
    assert.deepEqual(await follower.read(), [
      { inputTokens: 100, contextWindow: 400_000 },
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  assert.equal(codexHome({ CODEX_HOME: "/x/codex" }), "/x/codex");
  assert.equal(codexHome({ HOME: "/home/someone" }), "/home/someone/.codex");
});
