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

const steer = (id, second, text) =>
  event(`evt_${id}`, second, "Steered into active turn", text, {
    message: { id, kind: "user", text, at: at(second) },
  });
const finishedAt = (events, groupId) =>
  chatMessagesForThread(thread(events)).find(
    (message) => message.id === `agent-session:s:${groupId}:process`,
  );

test("a turn's first group counts from the input, through its silent wait", () => {
  const events = [
    input("in_1", 0, "Run the checks"),
    event("think_1", 5, "Thinking", "Claude is thinking."),
  ];
  const awaiting = liveGroup([events[0]]);
  assert.equal(awaiting.startedAt, at(0));
  assert.equal(liveGroup(events).startedAt, at(0));
  const finished = finishedAt(
    [
      ...events,
      event("tool_1", 8, "Using a tool", "Bash"),
      event("answer_1", 9, "Response stream", "Done."),
    ],
    "think_1",
  );
  assert.equal(finished.streaming, false);
  assert.equal(finished.startedAt, at(0));
  assert.equal(finished.durationMs, 8_000);
});

test("a turn a background task started counts from that wake-up", () => {
  const working = liveGroup([
    ...finishedTurn,
    wake,
    event("think_2", 105, "Thinking", "Claude is thinking."),
  ]);
  assert.equal(working.startedAt, at(100));
});

test("a live group keeps one start through its steps", () => {
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
  assert.equal(inStep.startedAt, at(100));
  assert.equal(between.startedAt, at(100));
});

// Mirrors sess_1791537694112193282: a message steered in while a tool runs;
// the next step only shows once that tool ends, well after the steer.
test("after a steer, the wait and the next group count from the steer", () => {
  const beforeSteer = [
    input("in_1", 0, "Fix CI"),
    event("think_1", 2, "Thinking", "Claude is thinking."),
    event("tool_1", 10, "Using a tool", "Bash"),
  ];
  const steered = [...beforeSteer, steer("in_2", 60, "Also check lint")];
  const awaiting = liveGroup(steered);
  assert.equal(awaiting.id, "agent-session:s:awaiting-step");
  assert.equal(awaiting.startedAt, at(60));

  const afterSteer = [
    ...steered,
    event("tool_done_1", 150, "Tool finished", "Bash"),
    event("think_2", 160, "Thinking", "Claude is thinking."),
  ];
  const live = liveGroup(afterSteer);
  assert.equal(live.startedAt, at(60));

  const messages = chatMessagesForThread(
    thread([
      ...afterSteer,
      event("tool_2", 190, "Using a tool", "Bash"),
      event("answer_2", 193, "Response stream", "Both pass."),
    ]),
  );
  const ids = messages.map((message) => message.id);
  const steerIndex = ids.indexOf("agent-session:s:in_2");
  assert.equal(ids[steerIndex - 1], "agent-session:s:think_1:process");
  assert.equal(ids[steerIndex + 1], "agent-session:s:tool_done_1:process");
  const finished = messages[steerIndex + 1];
  assert.equal(finished.startedAt, live.startedAt);
  // What the live timer read at the group's last step is what it then shows.
  assert.equal(finished.durationMs, Date.parse(at(190)) - Date.parse(at(60)));
});

const answer = (id, second, text) =>
  event(`evt_${id}`, second, "Response stream", text, {
    message: { id, kind: "assistant", text, at: at(second) },
  });

test("a later group in a turn counts from the answer before it", () => {
  const events = [
    input("in_1", 0, "Run the checks"),
    event("think_1", 2, "Thinking", "Claude is thinking."),
    answer("answer_1", 30, "Started them."),
    event("tool_2", 31, "Using a tool", "Bash"),
  ];
  const live = liveGroup(events);
  assert.equal(live.startedAt, at(30));
  const finished = finishedAt(
    [
      ...events,
      event("tool_3", 44, "Using a tool", "Bash"),
      answer("answer_2", 45, "All green."),
    ],
    "tool_2",
  );
  assert.equal(finished.startedAt, at(30));
  assert.equal(finished.durationMs, 14_000);
});
