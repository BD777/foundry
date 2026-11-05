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
  const tracker = new ClaudeRequestUsageTracker();
  const tool = { type: "tool_use", id: "toolu_1", name: "Bash", input: {} };
  const messages = [
    stream({ type: "message_start", message: { id: "msg_1", usage: zero } }),
    stream({ type: "content_block_start", index: 0, content_block: tool }),
    assistant("msg_1", { type: "thinking", thinking: "plan" }),
    assistant("msg_1", tool),
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
  const reported = messages
    .map((message) => tracker.observe(message))
    .filter(Boolean);
  assert.deepEqual(reported, [
    {
      requestId: "msg_1",
      inputTokens: 3212,
      cacheReadTokens: 3000,
      cacheWriteTokens: 200,
      outputTokens: 87,
    },
  ]);
  // Steps never carry a report of only zeros.
  for (const message of messages.filter((m) => m.type === "assistant")) {
    assert.equal(claudeRequestUsage(message), undefined);
    assert.equal(claudeProcessEvent(message)?.message?.requestUsage, undefined);
  }
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
  const tracker = new ClaudeRequestUsageTracker();
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
  assert.deepEqual(
    tracker.observe(stream({ type: "message_delta", delta: {} })),
    {
      requestId: "msg_3",
      inputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1,
    },
  );
  // Reported once: the stop that follows adds nothing.
  assert.equal(tracker.observe(stream({ type: "message_stop" })), undefined);
});

// Through some relays message_start (and the assistant messages repeating
// it) overstates the prompt several times over; Claude Code's own result
// usage follows message_delta. Numbers from a real AsterGate request.
test("the delta's prompt counts replace an overstated start", () => {
  const tracker = new ClaudeRequestUsageTracker();
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
  assert.deepEqual(
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
    {
      requestId: "msg_4",
      inputTokens: 235352,
      cacheReadTokens: 235015,
      cacheWriteTokens: 337,
      outputTokens: 40,
    },
  );
});

test("an understated start is raised to the delta, and a delta without prompt counts keeps the start", () => {
  const tracker = new ClaudeRequestUsageTracker();
  tracker.observe(
    stream({
      type: "message_start",
      message: {
        id: "msg_5",
        usage: { input_tokens: 4, cache_read_input_tokens: 7431 },
      },
    }),
  );
  assert.deepEqual(
    tracker.observe(
      stream({
        type: "message_delta",
        usage: { cache_read_input_tokens: 12961, output_tokens: 5 },
      }),
    ),
    {
      requestId: "msg_5",
      inputTokens: 12965,
      cacheReadTokens: 12961,
      cacheWriteTokens: 0,
      outputTokens: 5,
    },
  );
});
