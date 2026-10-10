import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register("./bundler-resolve.mjs", import.meta.url);
const { chatMessagesForThread } =
  await import("../src/features/chat/chat-model.ts");

// Mirrors a real session: a turn the person started ends, a finished
// background task wakes the agent for a new turn, and the person steers into
// that turn while it works.
const at = (second) =>
  new Date(Date.UTC(2026, 9, 10, 5, 0, second)).toISOString();
const event = (id, second, label, detail, extra = {}) => ({
  id,
  at: at(second),
  label,
  detail,
  level: "info",
  sessionId: "s",
  ...extra,
});
const input = (id, second, text) =>
  event(`evt_${id}`, second, "User message", "", {
    message: { id, kind: "user", text, at: at(second) },
  });
const thread = (events) => ({
  id: "t",
  sessions: [
    { id: "s", provider: "claude", prompt: "q", status: "running", events },
  ],
});
const liveGroup = (events) => {
  const last = chatMessagesForThread(thread(events)).at(-1);
  assert.equal(last.kind, "process");
  assert.equal(last.streaming, true);
  return last;
};

const finishedTurn = [
  input("in_1", 0, "Run the checks"),
  event("think_1", 1, "Thinking", "Claude is thinking."),
  event("answer_1", 2, "Response stream", "Started them."),
  event("done_1", 3, "Claude Agent SDK finished", "/tmp/result.json"),
];
const wake = event("wake", 100, "Background task continued", "Checks done", {
  metadata: {
    timerFire: {
      origin: "background",
      prompt: "Checks done",
      firedAt: at(100),
    },
  },
});

test("a turn a background task started counts from that wake-up", () => {
  const working = liveGroup([
    ...finishedTurn,
    wake,
    event("think_2", 105, "Thinking", "Claude is thinking."),
  ]);
  assert.equal(working.turnStartedAt, at(100));
});

test("the live timer keeps one start through steps and steers", () => {
  const base = [
    ...finishedTurn,
    wake,
    event("think_2", 105, "Thinking", "Claude is thinking."),
    event("tool_2", 110, "Using a tool", "Bash"),
  ];
  const inStep = liveGroup(base);
  const between = liveGroup([
    ...base,
    event("tool_done_2", 120, "Tool finished", "Bash"),
  ]);
  const afterSteer = liveGroup([
    ...base,
    event("steer", 130, "Steered into active turn", "Also check lint", {
      message: {
        id: "in_2",
        kind: "user",
        text: "Also check lint",
        at: at(130),
      },
    }),
    event("think_3", 131, "Thinking", "Claude is thinking."),
  ]);
  assert.equal(inStep.turnStartedAt, at(100));
  assert.equal(between.turnStartedAt, at(100));
  assert.equal(afterSteer.turnStartedAt, at(100));
});
