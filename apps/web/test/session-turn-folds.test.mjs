import assert from "node:assert/strict";
import test from "node:test";

const { foldSessionTurns } =
  await import("../src/components/conversation/session-turn-folds.ts");
const { chatThreadsFromSessions } =
  await import("../src/features/chat/session/chat-session-model.ts");
const { chatMessageItems, chatViewMessages } =
  await import("../src/features/chat/thread/chat-message-items.ts");

const child = (id) => ({ sessionId: id, label: `${id} title` });
let clock = 0;
const at = () => new Date(Date.UTC(2026, 10, 4, 8, clock++)).toISOString();
const person = (id, text = id) => ({ id, role: "user", text, at: at() });
const fromSession = (id, sender, extra = {}) => ({
  id,
  role: "user",
  text: id,
  at: at(),
  sentBy: child(sender),
  ...extra,
});
const answer = (id, extra = {}) => ({
  id,
  role: "bot",
  text: id,
  at: at(),
  ...extra,
});
const process = (id) => ({
  id,
  role: "bot",
  kind: "process",
  text: "",
  at: at(),
});
const ids = (rows) => rows.map((row) => row.id);
const none = new Set();

test("consecutive turns sessions started fold into one row; the person's turns stay", () => {
  const messages = [
    person("p1"),
    answer("a1"),
    fromSession("s1", "sess_a"),
    process("s1-work"),
    answer("s1-answer"),
    fromSession("s2", "sess_b"),
    answer("s2-answer"),
    fromSession("s3", "sess_a"),
    answer("s3-answer"),
    person("p2"),
    answer("a2"),
  ];
  const { rows, foldOf } = foldSessionTurns(messages, none);
  assert.deepEqual(ids(rows), ["p1", "a1", "session-turns:s1", "p2", "a2"]);
  const fold = rows[2];
  assert.equal(fold.kind, "session-turns");
  assert.equal(fold.sessionTurns.turnCount, 3);
  assert.equal(fold.sessionTurns.expanded, false);
  assert.deepEqual(
    fold.sessionTurns.senders.map((sender) => sender.sessionId),
    ["sess_a", "sess_b"],
  );
  assert.equal(fold.sessionTurns.firstAt, messages[2].at);
  assert.equal(fold.sessionTurns.lastAt, messages[8].at);
  assert.equal(foldOf.get("s2-answer"), "session-turns:s1");
  assert.equal(foldOf.get("p2"), undefined);
});

test("an open fold keeps its row above the turns, shown as they are", () => {
  const messages = [
    person("p1"),
    fromSession("s1", "sess_a"),
    answer("s1-answer"),
    person("p2"),
  ];
  const { rows } = foldSessionTurns(messages, new Set(["session-turns:s1"]));
  assert.deepEqual(ids(rows), [
    "p1",
    "session-turns:s1",
    "s1",
    "s1-answer",
    "p2",
  ]);
  assert.equal(rows[1].sessionTurns.expanded, true);
  assert.equal(rows[2], messages[1]);
});

test("the latest turn stays shown: a run that ends the chat folds all but its last turn", () => {
  const messages = [
    person("p1"),
    fromSession("s1", "sess_a"),
    answer("s1-answer"),
    fromSession("s2", "sess_a"),
    answer("s2-answer"),
  ];
  const { rows } = foldSessionTurns(messages, none);
  assert.deepEqual(ids(rows), ["p1", "session-turns:s1", "s2", "s2-answer"]);
  assert.equal(rows[1].sessionTurns.turnCount, 1);
  // A lone session turn that is the latest is not folded at all.
  const single = [person("p1"), fromSession("s1", "sess_a"), answer("x")];
  assert.equal(foldSessionTurns(single, none).rows, single);
});

test("a turn that runs, or where the person spoke, never folds", () => {
  const messages = [
    fromSession("s1", "sess_a"),
    answer("s1-answer", { streaming: true }),
    fromSession("s2", "sess_a"),
    person("p-steer"),
    answer("s2-answer"),
    person("p3"),
  ];
  // p-steer is a plain person message, so it starts its own turn: s2 then
  // folds alone, while the running s1 stays.
  const { rows } = foldSessionTurns(messages, none);
  assert.deepEqual(ids(rows), [
    "s1",
    "s1-answer",
    "session-turns:s2",
    "p-steer",
    "s2-answer",
    "p3",
  ]);
  const steeredPerson = [
    fromSession("s1", "sess_a"),
    { ...person("p-steer"), steered: true },
    answer("s1-answer"),
    person("p2"),
  ];
  assert.equal(foldSessionTurns(steeredPerson, none).rows, steeredPerson);
});

test("a session's message steered into the person's turn does not split it", () => {
  const messages = [
    person("p1"),
    fromSession("s-steer", "sess_a", { steered: true }),
    answer("a1"),
    person("p2"),
  ];
  assert.equal(foldSessionTurns(messages, none).rows, messages);
});

test("rows before the first loaded input are kept as they are", () => {
  const messages = [
    answer("older-answer"),
    fromSession("s1", "sess_a"),
    answer("s1-answer"),
    person("p1"),
  ];
  assert.deepEqual(ids(foldSessionTurns(messages, none).rows), [
    "older-answer",
    "session-turns:s1",
    "p1",
  ]);
});

test("the transcript marks messages steered into a turn, so folding sees turn inputs", () => {
  const when = "2026-11-04T08:00:00Z";
  const event = (id, label, extra) => ({
    id,
    sessionId: "sess_orch",
    at: when,
    label,
    detail: "",
    level: "info",
    ...extra,
  });
  const orchestrator = {
    id: "sess_orch",
    threadId: "sess_orch",
    workspaceId: "ws_1",
    status: "completed",
    title: "orchestrator",
    prompt: "go",
    input: { id: "in_3", prompt: "p" },
    events: [
      event("evt_in_1", "User message", {
        message: { id: "in_1", kind: "user", text: "report", at: when },
        metadata: { sentBySessionId: "sess_child" },
      }),
      event("evt_steer", "Steered into active turn", {
        detail: "and one more thing",
        metadata: { sentBySessionId: "sess_child" },
      }),
      event("evt_a1", "Response stream", {
        message: { id: "a1", kind: "assistant", text: "relayed", at: when },
      }),
      event("evt_in_3", "User message", {
        message: { id: "in_3", kind: "user", text: "and now?", at: when },
      }),
      event("evt_a3", "Response stream", {
        message: { id: "a3", kind: "assistant", text: "here", at: when },
      }),
    ],
  };
  const [thread] = chatThreadsFromSessions([orchestrator]);
  const { messages } = chatViewMessages({
    outbox: [],
    suppressedResponseFingerprints: new Set(),
    thread,
  });
  const items = chatMessageItems(messages, {
    agentActive: false,
    senderOf: (id) => ({ sessionId: id, label: id }),
  });
  const users = items.filter((item) => item.role === "user");
  assert.deepEqual(
    users.map((item) => [item.text, Boolean(item.steered)]),
    [
      ["report", false],
      ["and one more thing", true],
      ["and now?", false],
    ],
  );
  const { rows } = foldSessionTurns(items, none);
  assert.equal(rows[0].kind, "session-turns");
  assert.equal(rows[0].sessionTurns.turnCount, 1);
  assert.deepEqual(
    rows.slice(1).map((row) => row.text),
    ["and now?", "here"],
  );
});

const continued = (id, continuation) => ({
  id,
  role: "bot",
  kind: "boundary",
  text: "",
  at: at(),
  continuation,
});

test("turns the agent ran on its own (timers, background work) fold like other sessions' turns", () => {
  const messages = [
    person("p1"),
    answer("a1"),
    continued("t1", "scheduled"),
    answer("t1-answer"),
    fromSession("s1", "sess_a"),
    answer("s1-answer"),
    continued("b1", "background"),
    answer("b1-answer"),
    person("p2"),
    answer("a2"),
  ];
  const { rows, foldedTurns } = foldSessionTurns(messages, none);
  assert.deepEqual(ids(rows), ["p1", "a1", "session-turns:t1", "p2", "a2"]);
  assert.equal(foldedTurns, 3);
  assert.deepEqual(rows[2].sessionTurns.origins, {
    session: 1,
    scheduled: 1,
    background: 1,
  });
  assert.deepEqual(
    rows[2].sessionTurns.senders.map((sender) => sender.sessionId),
    ["sess_a"],
  );
});

test("a question that waits for an answer keeps its turn shown", () => {
  const asking = answer("s1-ask", {
    questions: [{ title: "Which?", options: ["A", "B"] }],
    questionItemId: "call_1",
    questionState: "assumed",
  });
  const messages = [
    person("p1"),
    fromSession("s1", "sess_a"),
    asking,
    fromSession("s2", "sess_a"),
    answer("s2-answer"),
    person("p2"),
  ];
  assert.deepEqual(ids(foldSessionTurns(messages, none).rows), [
    "p1",
    "s1",
    "s1-ask",
    "session-turns:s2",
    "p2",
  ]);
  const answered = messages.map((message) =>
    message === asking ? { ...asking, questionState: "answered" } : message,
  );
  assert.deepEqual(ids(foldSessionTurns(answered, none).rows), [
    "p1",
    "session-turns:s1",
    "p2",
  ]);
});

test("only my conversation hides those turns, the latest one too, but never a running one", () => {
  const messages = [
    person("p1"),
    answer("a1"),
    fromSession("s1", "sess_a"),
    answer("s1-answer"),
    continued("t1", "scheduled"),
    answer("t1-answer"),
  ];
  const hidden = foldSessionTurns(messages, none, { onlyMine: true });
  assert.deepEqual(ids(hidden.rows), ["p1", "a1"]);
  assert.equal(hidden.foldedTurns, 2);
  // Without it, the latest turn stays shown.
  assert.deepEqual(ids(foldSessionTurns(messages, none).rows), [
    "p1",
    "a1",
    "session-turns:s1",
    "t1",
    "t1-answer",
  ]);
  const running = [
    ...messages.slice(0, -1),
    answer("t1-answer", { streaming: true }),
  ];
  assert.deepEqual(
    ids(foldSessionTurns(running, none, { onlyMine: true }).rows),
    ["p1", "a1", "t1", "t1-answer"],
  );
});

test("the transcript marks a turn the agent ran on its own, so folding sees it", async () => {
  const { chatMessagesForThread } =
    await import("../src/features/chat/thread/chat-model.ts");
  const event = (id, second, fields) => ({
    id,
    at: new Date(Date.UTC(2026, 10, 5, 8, 0, second)).toISOString(),
    level: "info",
    sessionId: "s",
    detail: "",
    ...fields,
  });
  const messages = chatMessagesForThread({
    id: "t",
    sessions: [
      {
        id: "s",
        provider: "claude",
        prompt: "Watch the build",
        status: "completed",
        events: [
          event("evt_in", 1, {
            label: "User message",
            message: { id: "in_1", kind: "user", text: "Watch the build" },
          }),
          event("evt_answer", 2, {
            label: "Response stream",
            detail: "Watching.",
          }),
          event("evt_timer", 3, {
            label: "Timer fired",
            metadata: {
              timerFire: {
                origin: "scheduled",
                prompt: "check the build",
                response: "Still building.",
                startedAt: "2026-11-05T08:00:03Z",
                completedAt: "2026-11-05T08:00:04Z",
              },
            },
          }),
        ],
      },
    ],
  });
  const divider = messages.find((message) => message.kind === "boundary");
  assert.equal(divider?.continuation, "scheduled");
});
