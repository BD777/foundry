import assert from "node:assert/strict";
import test from "node:test";
import { claudeProcessEvent } from "../dist/session/runner/sdk-messages.js";
import {
  ClaudeRequestUsageTracker,
  claudeRequestUsage,
} from "../dist/session/usage/turn-usage.js";

const zero = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
};
const stream = (event, parent = null) => ({
  type: "stream_event",
  parent_tool_use_id: parent,
  event,
});
const assistant = (id, block, usage = zero) => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: { id, role: "assistant", content: [block], usage },
});

// What a relay sends: every assistant block and message_start report zeros;
// only message_delta carries the request's real tokens.
test("a request's real tokens come from its stream, once, when it ends", () => {
  let now = 0;
  const tracker = new ClaudeRequestUsageTracker({
    startedAt: 1_000,
    now: () => now,
  });
  const at = (time, message) => {
    now = time;
    return tracker.observe(message);
  };
  const tool = { type: "tool_use", id: "toolu_1", name: "Bash", input: {} };
  const messages = [
    stream({ type: "message_start", message: { id: "msg_1", usage: zero } }),
    stream({ type: "content_block_start", index: 0, content_block: tool }),
    assistant("msg_1", { type: "thinking", thinking: "plan" }),
    assistant("msg_1", tool),
    stream({
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking: "plan" },
    }),
    stream({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "answer" },
    }),
    stream({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: {
        input_tokens: 12,
        cache_read_input_tokens: 3000,
        cache_creation_input_tokens: 200,
        output_tokens: 87,
      },
    }),
    stream({ type: "message_stop" }),
  ];
  const reported = [
    at(1_000, messages[0]),
    at(1_010, messages[1]),
    at(1_020, messages[2]),
    at(1_030, messages[3]),
    at(1_125, messages[4]),
    at(1_250, messages[5]),
    at(1_400, messages[6]),
    at(1_600, messages[7]),
  ].filter(Boolean);
  assert.deepEqual(reported, [
    {
      requestId: "msg_1",
      inputTokens: 3212,
      cacheReadTokens: 3000,
      cacheWriteTokens: 200,
      outputTokens: 87,
      firstTokenMs: 125,
      generationMs: 475,
      requestMs: 600,
    },
  ]);
  // Steps never carry a report of only zeros.
  for (const message of messages.filter((m) => m.type === "assistant")) {
    assert.equal(claudeRequestUsage(message), undefined);
    assert.equal(claudeProcessEvent(message)?.message?.requestUsage, undefined);
  }
});

test("a request carries the model named by its message_start", () => {
  let now = 1_000;
  const tracker = new ClaudeRequestUsageTracker({
    startedAt: 1_000,
    now: () => now,
  });
  tracker.observe(
    stream({
      type: "message_start",
      message: {
        id: "msg_model",
        model: "claude-sonnet-4-5[1m]",
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    }),
  );
  now = 1_250;
  assert.deepEqual(tracker.observe(stream({ type: "message_stop" })), {
    requestId: "msg_model",
    model: "claude-sonnet-4-5",
    inputTokens: 12,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    requestMs: 250,
  });
});

test("a request that never reports tokens yields nothing; subagent streams are not followed", () => {
  const tracker = new ClaudeRequestUsageTracker();
  assert.equal(
    tracker.observe(
      stream({ type: "message_start", message: { id: "msg_2", usage: zero } }),
    ),
    undefined,
  );
  assert.equal(
    tracker.observe(stream({ type: "message_delta", usage: zero })),
    undefined,
  );
  assert.equal(tracker.observe(stream({ type: "message_stop" })), undefined);

  const sub = new ClaudeRequestUsageTracker();
  sub.observe(
    stream(
      { type: "message_start", message: { id: "msg_s", usage: zero } },
      "toolu_parent",
    ),
  );
  assert.equal(
    sub.observe(
      stream(
        { type: "message_delta", usage: { output_tokens: 9 } },
        "toolu_parent",
      ),
    ),
    undefined,
  );
});

test("a request whose delta carries no usage reports what its start said", () => {
  let now = 1_000;
  const tracker = new ClaudeRequestUsageTracker({
    startedAt: 1_000,
    now: () => now,
  });
  tracker.observe(
    stream({
      type: "message_start",
      message: {
        id: "msg_3",
        usage: {
          input_tokens: 50,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
      },
    }),
  );
  assert.equal(
    tracker.observe(stream({ type: "message_delta", delta: {} })),
    undefined,
  );
  now = 1_500;
  assert.deepEqual(tracker.observe(stream({ type: "message_stop" })), {
    requestId: "msg_3",
    inputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 1,
    requestMs: 500,
  });
});

// Through some relays message_start (and the assistant messages repeating
// it) overstates the prompt several times over; Claude Code's own result
// usage follows message_delta. Numbers from a real AsterGate request.
test("the delta's prompt counts replace an overstated start", () => {
  let now = 0;
  const tracker = new ClaudeRequestUsageTracker({
    startedAt: 0,
    now: () => now,
  });
  const overstated = {
    input_tokens: 0,
    cache_read_input_tokens: 539683,
    cache_creation_input_tokens: 773,
    output_tokens: 1,
  };
  tracker.observe(
    stream({
      type: "message_start",
      message: { id: "msg_4", usage: overstated },
    }),
  );
  tracker.observe(assistant("msg_4", { type: "text", text: "ok" }, overstated));
  assert.equal(
    tracker.observe(
      stream({
        type: "message_delta",
        usage: {
          input_tokens: 0,
          cache_read_input_tokens: 235015,
          cache_creation_input_tokens: 337,
          output_tokens: 40,
        },
      }),
    ),
    undefined,
  );
  now = 500;
  assert.deepEqual(tracker.observe(stream({ type: "message_stop" })), {
    requestId: "msg_4",
    inputTokens: 235352,
    cacheReadTokens: 235015,
    cacheWriteTokens: 337,
    outputTokens: 40,
    requestMs: 500,
  });
});

test("an understated start is raised to the delta, and a delta without prompt counts keeps the start", () => {
  let now = 0;
  const tracker = new ClaudeRequestUsageTracker({
    startedAt: 0,
    now: () => now,
  });
  tracker.observe(
    stream({
      type: "message_start",
      message: {
        id: "msg_5",
        usage: { input_tokens: 4, cache_read_input_tokens: 7431 },
      },
    }),
  );
  assert.equal(
    tracker.observe(
      stream({
        type: "message_delta",
        usage: { cache_read_input_tokens: 12961, output_tokens: 5 },
      }),
    ),
    undefined,
  );
  now = 500;
  assert.deepEqual(tracker.observe(stream({ type: "message_stop" })), {
    requestId: "msg_5",
    inputTokens: 12965,
    cacheReadTokens: 12961,
    cacheWriteTokens: 0,
    outputTokens: 5,
    requestMs: 500,
  });
});

test("a result flushes a stream that ends without message_stop, without generation time", () => {
  let now = 0;
  const tracker = new ClaudeRequestUsageTracker({ now: () => now });
  const at = (time, message) => {
    now = time;
    return tracker.observe(message);
  };
  at(
    2_000,
    stream({ type: "message_start", message: { id: "msg_7", usage: zero } }),
  );
  at(
    2_125,
    stream({
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking: "plan" },
    }),
  );
  at(
    2_300,
    stream({
      type: "message_delta",
      usage: { input_tokens: 5, output_tokens: 12 },
    }),
  );
  assert.deepEqual(at(2_400, { type: "result" }), {
    requestId: "msg_7",
    inputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 12,
    firstTokenMs: 125,
  });
  assert.equal(tracker.flush(), undefined);
});

test("a later request starts when the SDK delivers its tool_result user message", () => {
  let now = 1_000;
  const tracker = new ClaudeRequestUsageTracker({
    startedAt: 1_000,
    now: () => now,
  });
  tracker.observe(
    stream({
      type: "message_start",
      message: { id: "msg_first", usage: zero },
    }),
  );
  now = 1_002;
  tracker.observe(
    stream({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "calling a tool" },
    }),
  );
  tracker.observe(
    stream({ type: "message_delta", usage: { output_tokens: 2 } }),
  );
  now = 1_100;
  assert.deepEqual(tracker.observe(stream({ type: "message_stop" })), {
    requestId: "msg_first",
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 2,
    firstTokenMs: 2,
    generationMs: 98,
    requestMs: 100,
  });

  now = 5_000;
  tracker.observe({
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
    },
  });
  now = 5_001;
  tracker.observe(
    stream({
      type: "message_start",
      message: { id: "msg_second", usage: zero },
    }),
  );
  now = 5_003;
  tracker.observe(
    stream({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "done" },
    }),
  );
  tracker.observe(
    stream({ type: "message_delta", usage: { output_tokens: 3 } }),
  );
  now = 5_600;
  assert.deepEqual(tracker.observe(stream({ type: "message_stop" })), {
    requestId: "msg_second",
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 3,
    firstTokenMs: 2,
    generationMs: 597,
    requestMs: 600,
  });
});

// The steps of a request carry what its start said (ModelRequestUsage: the
// request's last report counts); the tracker's report, which follows them,
// settles it. Numbers from a real AsterGate request (DEV-142 follow-up),
// whose start put 1738959 tokens in cache writes.
test("steps carry the start's estimate and the tracker's later report settles it", () => {
  let now = 0;
  const tracker = new ClaudeRequestUsageTracker({
    startedAt: 0,
    now: () => now,
  });
  const estimated = {
    input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 1738959,
    output_tokens: 0,
  };
  const tool = { type: "tool_use", id: "toolu_6", name: "Bash", input: {} };
  const messages = [
    stream({
      type: "message_start",
      message: { id: "msg_6", usage: estimated },
    }),
    assistant("msg_6", { type: "thinking", thinking: "plan" }, estimated),
    assistant("msg_6", tool, estimated),
    stream({
      type: "message_delta",
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 301585,
        output_tokens: 691,
      },
    }),
    stream({ type: "message_stop" }),
  ];
  const steps = messages
    .filter((message) => message.type === "assistant")
    .map((message) => claudeProcessEvent(message)?.message?.requestUsage);
  assert.deepEqual(
    steps.map((usage) => usage?.inputTokens),
    [1738959, 1738959],
  );
  assert.deepEqual(
    messages
      .map((message) => {
        if (
          message.type === "stream_event" &&
          message.event.type === "message_stop"
        )
          now = 900;
        return tracker.observe(message);
      })
      .filter(Boolean),
    [
      {
        requestId: "msg_6",
        inputTokens: 301585,
        cacheReadTokens: 0,
        cacheWriteTokens: 301585,
        outputTokens: 691,
        requestMs: 900,
      },
    ],
  );
});
