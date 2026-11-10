import assert from "node:assert/strict";
import test from "node:test";
import { CodexTimingTracker } from "../dist/session/usage/codex-timing.js";
import { codexTurnUsage } from "../dist/session/usage/turn-usage.js";

test("Codex timing subtracts merged parallel tool intervals and uses the first output delta", () => {
  let now = 0;
  const tracker = new CodexTimingTracker({
    startedAt: 99_500,
    now: () => now,
  });
  now = 101_500;
  tracker.observe("item/reasoning/textDelta", {
    turnId: "turn-1",
    itemId: "reasoning-1",
    delta: "thinking",
  });
  now = 102_000;
  tracker.observe("item/started", {
    item: { id: "command-1", type: "commandExecution" },
  });
  now = 102_500;
  tracker.observe("item/started", {
    item: { id: "mcp-1", type: "mcpToolCall" },
  });
  now = 104_000;
  tracker.observe("item/completed", {
    item: { id: "command-1", type: "commandExecution" },
  });
  now = 105_000;
  tracker.observe("item/completed", {
    item: { id: "mcp-1", type: "mcpToolCall" },
  });
  now = 106_000;
  tracker.observe("item/agentMessage/delta", {
    turnId: "turn-1",
    itemId: "message-1",
    delta: "answer",
  });

  const timing = tracker.finish({ startedAt: 100, completedAt: 107 });
  assert.deepEqual(timing, {
    modelMs: 4_000,
    ttftMs: 1_500,
    timingEstimated: true,
  });
  assert.equal(
    codexTurnUsage({
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 50,
        output_tokens: 20,
      },
      timing,
    })?.timingEstimated,
    true,
  );
});

test("a Codex turn with no tool items reports its full duration as model time", () => {
  let now = 1_000;
  const tracker = new CodexTimingTracker({ startedAt: 1_000, now: () => now });
  now = 1_250;
  tracker.observe("item/agentMessage/delta", {
    turnId: "turn-2",
    itemId: "message-2",
    delta: "answer",
  });
  now = 6_000;
  assert.deepEqual(tracker.finish({ durationMs: 5_000 }), {
    modelMs: 5_000,
    ttftMs: 250,
    timingEstimated: true,
  });
});

test("a failed Codex turn keeps the model timing accumulated before it ended", () => {
  let now = 1_000;
  const tracker = new CodexTimingTracker({ startedAt: 1_000, now: () => now });
  tracker.observe("item/started", {
    item: {
      id: "tool",
      type: "commandExecution",
      startedAtMs: 1_100,
    },
  });
  now = 1_500;
  tracker.observe("item/completed", {
    item: {
      id: "tool",
      type: "commandExecution",
      completedAtMs: 1_500,
    },
  });
  now = 1_600;
  tracker.observe("item/agentMessage/delta", {
    turnId: "turn-failed",
    itemId: "answer",
    delta: "partial",
  });
  now = 2_000;
  assert.deepEqual(
    tracker.finish({
      startedAt: 1,
      completedAt: 2,
      status: "failed",
    }),
    {
      modelMs: 600,
      ttftMs: 600,
      timingEstimated: true,
    },
  );
});
