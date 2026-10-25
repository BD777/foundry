import assert from "node:assert/strict";
import test from "node:test";
import { handleActiveClaudeMessage } from "../dist/runner/claude-messages.js";
import {
  setOutOfBandSessionEventSink,
  clearOutOfBandSessionEventSink,
} from "../dist/session-state.js";

const progress = {
  type: "assistant",
  uuid: "narration-frame",
  narration_block_indexes: [0],
  thinking_display: "updates",
  message: {
    id: "request-progress",
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: "Checked the handler; adding a regression test.",
      },
    ],
  },
};

test("the Claude runner emits narration once as commentary without changing the answer", async () => {
  const events = [];
  const turn = {
    emit: async (label, detail, level, metadata, message) =>
      events.push({ label, detail, message }),
    finalResult: "",
    partialResult: "",
    openTaskIds: new Set(),
    liveness: { observe: () => [] },
  };
  const runtime = {
    foundrySessionId: "narration-test",
    pending: turn,
    lastUsed: Date.now(),
  };
  await handleActiveClaudeMessage(runtime, progress);
  assert.equal(events.length, 1);
  assert.equal(events[0].message.kind, "commentary");
  assert.equal(turn.finalResult, "");
  await handleActiveClaudeMessage(runtime, {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Fixed and tested." }],
    },
  });
  assert.equal(turn.finalResult, "Fixed and tested.");
  assert.equal(events.at(-1).label, "Response stream");
});

test("Claude background continuation keeps narration separate from its final response", async () => {
  const events = [];
  const sink = (_sessionId, event) => events.push(event);
  setOutOfBandSessionEventSink(sink);
  try {
    const runtime = {
      foundrySessionId: "narration-background",
      lastUsed: Date.now(),
    };
    await handleActiveClaudeMessage(runtime, progress);
    assert.equal(events.length, 1);
    assert.equal(events[0].message.kind, "commentary");
    assert.equal(runtime.continuation.finalResult, "");
    await handleActiveClaudeMessage(runtime, {
      ...progress,
      parent_tool_use_id: "subagent",
    });
    assert.equal(
      events.length,
      1,
      "forwarded subagents do not leak into the parent",
    );
  } finally {
    clearOutOfBandSessionEventSink(sink);
  }
});
