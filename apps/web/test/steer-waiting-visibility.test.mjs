import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./bundler-resolve.mjs", import.meta.url);
const { turnActivity } = await import("../src/features/chat/turn-activity.ts");
const { chatMessagesForThread } =
  await import("../src/features/chat/chat-model.ts");
const { chatMessageItems } =
  await import("../src/features/chat/chat-message-items.ts");
const { i18n } = await import("../src/i18n/index.ts");

let sequence = 0;
const event = (at, label, extra = {}) => ({
  id: `evt_${++sequence}`,
  sessionId: "s",
  at: `2026-10-29T${at}Z`,
  label,
  detail: extra.detail ?? "",
  level: "info",
  ...(extra.metadata ? { metadata: extra.metadata } : {}),
  ...(extra.message ? { message: extra.message } : {}),
});
const tool = (at, status, detail = "Bash") =>
  event(at, status === "running" ? "Using tool" : "Used tool", {
    detail,
    message: {
      id: "call_1",
      kind: "tool",
      callId: "call_1",
      status,
      title: status === "running" ? "Using tool" : "Used tool",
      text: detail,
    },
  });
const command =
  'Bash\n\n```json\n{"command":"timeout 1200 python3 -m unittest discover","description":"Identify the failing test"}\n```';

/** The person's case: a 20-minute test run, a message steered in 11 s later. */
function personsCase({ returned }) {
  return [
    event("13:40:00", "User message", {
      message: { id: "in_1", kind: "user", text: "go" },
    }),
    event("13:40:41", "Requesting model"),
    tool("13:40:43", "running"),
    tool("13:40:44", "running", command),
    event("13:40:47", "Starting subtask", {
      detail: "Identify the failing test",
      metadata: { taskId: "b1", toolUseId: "call_1" },
    }),
    event("13:40:55", "Steered into active turn", { detail: "two things" }),
    ...(returned
      ? [
          tool("13:45:33", "completed", command),
          event("13:45:33.4", "Requesting model"),
        ]
      : []),
  ];
}

test("a running tool started before the steered message is the turn's activity", () => {
  const activity = turnActivity(
    { id: "s", provider: "claude", events: personsCase({ returned: false }) },
    true,
  );
  assert.equal(activity.running.length, 1);
  const [running] = activity.running;
  assert.equal(running.callId, "call_1");
  assert.equal(running.startedAt, "2026-10-29T13:40:43Z");
  assert.equal(running.taskId, "b1");
  assert.match(running.detail, /unittest discover/);
});

test("Claude: delivered and waiting behind the tool, then read at the next model request", () => {
  const steerId = (events) =>
    `agent-session:s:${events.find((e) => e.label === "Steered into active turn").id}`;
  const waiting = personsCase({ returned: false });
  const before = turnActivity(
    { id: "s", provider: "claude", events: waiting },
    true,
  ).steers.get(steerId(waiting));
  assert.equal(before.state, "waiting");
  assert.equal(before.deliveredAt, "2026-10-29T13:40:55Z");
  assert.deepEqual(
    before.blockers.map((tool) => [tool.callId, tool.taskId]),
    [["call_1", "b1"]],
  );

  const read = personsCase({ returned: true });
  const after = turnActivity(
    { id: "s", provider: "claude", events: read },
    true,
  ).steers.get(steerId(read));
  assert.equal(after.state, "read");
  assert.equal(after.readAt, "2026-10-29T13:45:33.4Z");
  assert.deepEqual(after.blockers, []);
});

test("Claude: a model request while the tool still runs does not read the message", () => {
  const events = [
    ...personsCase({ returned: false }),
    event("13:41:10", "Requesting model"),
  ];
  const id = `agent-session:s:${events.find((e) => e.label === "Steered into active turn").id}`;
  assert.equal(
    turnActivity({ id: "s", provider: "claude", events }, true).steers.get(id)
      .state,
    "waiting",
  );
});

test("a turn that ended leaves an unread message without a state, and nothing running", () => {
  const events = personsCase({ returned: false });
  const activity = turnActivity({ id: "s", provider: "claude", events }, false);
  assert.deepEqual(activity.running, []);
  assert.equal(activity.steers.size, 0);
});

test("a new input ends what the last turn left running", () => {
  const events = [
    ...personsCase({ returned: false }),
    event("13:50:00", "User message", {
      message: { id: "in_2", kind: "user", text: "again" },
    }),
  ];
  const activity = turnActivity({ id: "s", provider: "claude", events }, true);
  assert.deepEqual(activity.running, []);
  assert.equal(activity.steers.size, 0);
});

test("Codex: read when the tool it waited behind returns; at once when none runs", () => {
  const events = [
    event("10:00:00", "User message", {
      message: { id: "in_1", kind: "user", text: "go" },
    }),
    tool("10:00:01", "running", "$ sleep 30"),
    event("10:00:02", "Steered into active turn", { detail: "one" }),
    tool("10:00:31", "completed", "$ sleep 30"),
    event("10:00:40", "Steered into active turn", {
      detail: "two",
      message: { id: "steer_x", kind: "user", text: "two" },
    }),
  ];
  const activity = turnActivity({ id: "s", provider: "codex", events }, true);
  const [first, second] = [...activity.steers.values()];
  assert.equal(first.state, "read");
  assert.equal(first.readAt, "2026-10-29T10:00:31Z");
  assert.equal(second.state, "read");
  assert.equal(second.readAt, "2026-10-29T10:00:40Z");
  assert.ok(activity.steers.has("agent-session:s:steer_x"));
});

const limited =
  'Bash\n\n```json\n{"command":"for i in 1 2 3 4; do sleep 60; done","description":"Measure backup write rate","timeout":240000}\n```';
const thread = (events, extra = {}) => ({
  id: "t",
  sessions: [
    {
      id: "s",
      provider: "claude",
      status: "running",
      prompt: "go",
      events,
      ...extra,
    },
  ],
});

test("under the steered message the live row names the running call, its time and its limit", () => {
  const events = [
    event("14:09:00", "User message", {
      message: { id: "in_1", kind: "user", text: "go" },
    }),
    tool("14:09:20", "running"),
    tool("14:09:21", "running", limited),
    event("14:09:24", "Starting subtask", {
      metadata: { taskId: "b9", toolUseId: "call_1" },
    }),
    event("14:09:52", "Steered into active turn", { detail: "status?" }),
  ];
  const messages = chatMessagesForThread(thread(events));
  const live = messages.at(-1);
  assert.equal(live.id, "agent-session:s:awaiting-step");
  assert.deepEqual(live.liveActivity, {
    callId: "call_1",
    title: i18n.t("conversation:processLabels.usingTool"),
    detail: "Bash · Measure backup write rate",
    startedAt: "2026-10-29T14:09:20Z",
    limitMs: 240000,
  });
  const steered = messages.at(-2);
  assert.equal(steered.role, "user");
  assert.equal(steered.steer.state, "waiting");
  assert.deepEqual(steered.steer.tool, {
    name: "Bash",
    startedAt: "2026-10-29T14:09:20Z",
    limitMs: 240000,
  });
  assert.deepEqual(steered.steerBlockerTask, { sessionId: "s", taskId: "b9" });

  const stops = [];
  const items = chatMessageItems(messages, {
    agentActive: true,
    onTurnIntoIssue() {},
    stopTask: async (sessionId, taskId) => void stops.push([sessionId, taskId]),
  });
  const item = items.find((entry) => entry.steer);
  assert.equal(typeof item.onStopSteerBlocker, "function");
  return item
    .onStopSteerBlocker()
    .then(() => assert.deepEqual(stops, [["s", "b9"]]));
});

test("Codex steers offer no stop, and a viewer without stopTask gets none", () => {
  const events = [
    event("14:00:00", "User message", {
      message: { id: "in_1", kind: "user", text: "go" },
    }),
    tool("14:00:01", "running", limited),
    event("14:00:02", "Starting subtask", {
      metadata: { taskId: "b9", toolUseId: "call_1" },
    }),
    event("14:00:03", "Steered into active turn", { detail: "status?" }),
  ];
  const codex = chatMessagesForThread(
    thread(events, { provider: "codex" }),
  ).find((message) => message.steer);
  assert.equal(codex.steer.runtime, "codex");
  assert.equal(codex.steerBlockerTask, undefined);
  const claude = chatMessagesForThread(thread(events));
  const [item] = chatMessageItems(claude, {
    agentActive: true,
    onTurnIntoIssue() {},
  }).filter((entry) => entry.steer);
  assert.equal(item.onStopSteerBlocker, undefined);
});
