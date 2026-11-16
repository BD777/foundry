import assert from "node:assert/strict";
import test from "node:test";

const { visibleSessionTurns } =
  await import("../src/components/conversation/session-turns.ts");
const { continuationTitle, isTurnInput, sourceBody, turnSource } =
  await import("../src/components/conversation/turn-source.ts");
const { chatThreadsFromSessions } =
  await import("../src/features/chat/session/chat-session-model.ts");
const { chatMessageItems, chatViewMessages } =
  await import("../src/features/chat/thread/chat-message-items.ts");

const child = (id, label = `${id} title`) => ({ sessionId: id, label });
let clock = 0;
const at = () => new Date(Date.UTC(2026, 10, 4, 8, clock++)).toISOString();
const person = (id, text = id, extra = {}) => ({
  id,
  role: "user",
  text,
  at: at(),
  ...extra,
});
const fromSession = (id, sender, text = id, extra = {}) => ({
  id,
  role: "user",
  text,
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
const continued = (id, continuation, detail) => ({
  id,
  role: "bot",
  kind: "boundary",
  text: "",
  at: at(),
  continuation,
  ...(detail ? { continuationDetail: detail } : {}),
});
const ids = (rows) => rows.map((row) => row.id);

test("every turn stays inline and in order, however it started", () => {
  const messages = [
    person("p1"),
    answer("a1"),
    fromSession("s1", "sess_a"),
    answer("s1-answer"),
    continued("t1", "scheduled", "patrol"),
    answer("t1-answer"),
    fromSession("s2", "sess_b"),
    answer("s2-answer"),
    person("p2"),
    answer("a2"),
  ];
  const { rows, hiddenTurns } = visibleSessionTurns(messages);
  // Nothing folded, nothing hidden: the person's answer after a background
  // turn can never disappear inside another row.
  assert.equal(rows, messages);
  assert.equal(hiddenTurns, 0);
});

test("each input names the source that started its turn", () => {
  const report =
    'Foundry report: session sess_c ("Helper"), which this session created, finished a turn: completed.\n\nFinal answer:\nDeployed.';
  const sources = [
    [person("p1"), undefined],
    [fromSession("s1", "sess_a"), { kind: "session", title: "sess_a title" }],
    [
      fromSession("r1", "sess_c", report),
      { kind: "report", title: "sess_c title" },
    ],
    [
      continued("bg", "background", "Deploy finished"),
      { kind: "background", title: undefined },
    ],
    [
      continued("tm", "scheduled", "Patrol the build"),
      { kind: "scheduled", title: "Patrol the build" },
    ],
    [person("n1", "[Foundry] a helper is back"), { kind: "notice" }],
    [
      person("c1", "hello", { channelOrigin: { channel: "openlark" } }),
      { kind: "channel" },
    ],
    [
      continued("auto", "watched-folder"),
      { kind: "automatic", raw: "watched-folder" },
    ],
    [answer("a1"), undefined],
  ];
  for (const [message, expected] of sources) {
    const source = turnSource(message);
    if (!expected) {
      assert.equal(source, undefined, message.id);
      continue;
    }
    assert.deepEqual(
      { kind: source.kind, title: source.title, raw: source.raw },
      { kind: expected.kind, title: expected.title, raw: expected.raw },
      message.id,
    );
  }
});

test("the server's structured inputSource wins over prompt markers", () => {
  const report = person("r1", "Foundry report: prose", {
    inputSource: {
      kind: "child_report",
      sessionId: "sess_c",
      title: "部署助手",
      status: "completed",
      response: "只显示最终回答。",
    },
  });
  const reportSource = turnSource(report);
  assert.equal(reportSource.kind, "report");
  assert.equal(reportSource.title, "部署助手");
  assert.equal(reportSource.status, "completed");
  assert.equal(sourceBody(report), "只显示最终回答。");
  // A failed report keeps its status, and its error stands in for an answer.
  const failed = person("r2", "report prose", {
    inputSource: {
      kind: "child_report",
      sessionId: "sess_d",
      title: "审阅助手",
      status: "failed",
      response: "Error: tests failed",
    },
  });
  assert.equal(turnSource(failed).status, "failed");
  assert.equal(sourceBody(failed), "Error: tests failed");
  // The person's own input is never a system row, even when its text looks
  // like a Foundry marker.
  assert.equal(
    turnSource(
      person("p1", "Foundry report: not really", {
        inputSource: { kind: "person" },
      }),
    ),
    undefined,
  );
  // Structured sources need no marker in the text.
  const notice = person("n1", "设备已恢复在线", {
    inputSource: { kind: "foundry_notice" },
  });
  assert.equal(turnSource(notice).kind, "notice");
  const peer = person("s1", "one more thing", {
    inputSource: { kind: "session", sessionId: "sess_peer", title: "审阅会话" },
  });
  assert.equal(turnSource(peer).kind, "session");
  assert.equal(turnSource(peer).title, "审阅会话");
  const background = continued("bg1", "background", "Deploy finished");
  background.inputSource = { kind: "background" };
  assert.equal(turnSource(background).kind, "background");
  assert.equal(turnSource(background).detail, "Deploy finished");
  assert.equal(turnSource(background).title, undefined);
});

test("a background turn names its task, keeping the command under the expansion", () => {
  const message = continued("bg2", "background", "Background command finished");
  message.continuationBody =
    'Background task finished: Background command "sleep 720" completed (exit code 0)';
  message.backgroundTasks = [
    {
      id: "bsleep",
      kind: "command",
      description: "Sleep 12 minutes",
      status: "completed",
      exitCode: 0,
      sessionId: "sess_chat",
    },
  ];
  const source = turnSource(message);
  assert.equal(source.kind, "background");
  // The row's title says what ran and how it ended; the prompt stays detail.
  assert.equal(source.tasks.length, 1);
  assert.equal(source.tasks[0].kind, "command");
  assert.equal(source.tasks[0].sessionId, "sess_chat");
  assert.match(source.detail, /exit code 0/);
});

test("a long scheduled prompt keeps a short title and expands to the whole prompt", () => {
  const short = continued("tm1", "scheduled");
  short.continuationBody = "Patrol the build";
  const shortSource = turnSource(short);
  assert.equal(shortSource.title, "Patrol the build");
  assert.equal(shortSource.detail, undefined);

  const long = continued("tm2", "scheduled");
  long.continuationBody =
    "Patrol the build\nCheck every failed job and the latest deploy log.";
  const longSource = turnSource(long);
  assert.equal(longSource.title, "Patrol the build");
  assert.equal(
    longSource.detail,
    "Patrol the build\nCheck every failed job and the latest deploy log.",
  );

  const clipped = continuationTitle("x".repeat(120));
  assert.equal(clipped.length, 81);
  assert.ok(clipped.endsWith("…"));
});

test("a message steered into a running turn is not a turn input", () => {
  assert.equal(
    isTurnInput(
      fromSession("s-steer", "sess_a", "also this", { steered: true }),
    ),
    false,
  );
  assert.equal(
    isTurnInput(
      fromSession("s-steer-2", "sess_a", "also this", {
        steer: { runtime: "claude", state: "waiting", deliveredAt: at() },
      }),
    ),
    false,
  );
  assert.equal(isTurnInput(fromSession("s1", "sess_a")), true);
});

test("only my conversation hides foreign turns, the latest too, but not a running one", () => {
  const messages = [
    person("p1"),
    answer("a1"),
    fromSession("s1", "sess_a"),
    answer("s1-answer"),
    continued("t1", "scheduled", "patrol"),
    answer("t1-answer"),
  ];
  const hidden = visibleSessionTurns(messages, { onlyMine: true });
  assert.deepEqual(ids(hidden.rows), ["p1", "a1"]);
  assert.equal(hidden.hiddenTurns, 2);
  // A turn still running stays: its partial answer is not hidden.
  const running = [
    ...messages.slice(0, -1),
    answer("t1-answer", { streaming: true }),
  ];
  assert.deepEqual(ids(visibleSessionTurns(running, { onlyMine: true }).rows), [
    "p1",
    "a1",
    "t1",
    "t1-answer",
  ]);
});

test("a turn where the person spoke, or a question waits, stays in only-my-conversation", () => {
  const asking = answer("s1-ask", {
    questions: [{ title: "Which?", options: ["A", "B"] }],
    questionItemId: "call_1",
    questionState: "assumed",
  });
  const askingTurn = [
    person("p1"),
    fromSession("s1", "sess_a"),
    asking,
    answer("s1-answer"),
    person("p2"),
  ];
  assert.deepEqual(
    ids(visibleSessionTurns(askingTurn, { onlyMine: true }).rows),
    ids(askingTurn),
  );
  const answered = askingTurn.map((message) =>
    message === asking ? { ...asking, questionState: "answered" } : message,
  );
  assert.deepEqual(
    ids(visibleSessionTurns(answered, { onlyMine: true }).rows),
    ["p1", "p2"],
  );
  // The person steering a message into a foreign turn keeps that turn.
  const steered = [
    person("p1"),
    fromSession("s1", "sess_a"),
    person("p-steer", "also this", { steered: true }),
    answer("s1-answer"),
    person("p2"),
  ];
  const { rows, hiddenTurns } = visibleSessionTurns(steered, {
    onlyMine: true,
  });
  assert.deepEqual(ids(rows), ids(steered));
  assert.equal(hiddenTurns, 0);
});

test("the transcript carries the timer or background work that started a turn", async () => {
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
                prompt: "check the build\nand report what is left",
                response: "Still building.",
                startedAt: "2026-11-05T08:00:03Z",
                completedAt: "2026-11-05T08:00:04Z",
              },
            },
          }),
          event("evt_background", 5, {
            label: "Background task continued",
            metadata: {
              timerFire: {
                origin: "background",
                prompt:
                  'Background command "sleep 720" completed (exit code 0)',
                response: "Sleep finished.",
                startedAt: "2026-11-05T08:10:00Z",
                completedAt: "2026-11-05T08:10:02Z",
                tasks: [
                  {
                    id: "bsleep",
                    kind: "command",
                    description: "Sleep 12 minutes",
                    status: "completed",
                    exitCode: 0,
                  },
                ],
              },
            },
          }),
        ],
      },
    ],
  });
  const dividers = messages.filter((message) => message.kind === "boundary");
  assert.equal(dividers[0]?.continuation, "scheduled");
  assert.equal(dividers[0]?.continuationDetail, "check the build");
  assert.equal(
    dividers[0]?.continuationBody,
    "check the build\nand report what is left",
  );
  assert.equal(dividers[1]?.continuation, "background");
  assert.equal(dividers[1]?.backgroundTasks?.[0]?.id, "bsleep");
  assert.equal(
    dividers[1]?.backgroundTasks?.[0]?.sessionId,
    "s",
    "each task carries the session its output is read through",
  );
  assert.match(dividers[1]?.continuationBody ?? "", /exit code 0/);
});

test("the transcript marks a child report and another session's input, so rows tell them apart", () => {
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
      event("evt_report", "User message", {
        message: {
          id: "in_1",
          kind: "user",
          text: 'Foundry report: session sess_child ("Helper") finished.',
          at: when,
        },
        metadata: { sentBySessionId: "sess_child" },
      }),
      event("evt_session", "User message", {
        message: { id: "in_2", kind: "user", text: "one more thing", at: when },
        metadata: { sentBySessionId: "sess_peer" },
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
    senderOf: (id) => child(id),
  });
  const [report, session, mine] = items.filter((item) => item.role === "user");
  assert.equal(turnSource(report).kind, "report");
  assert.equal(turnSource(report).title, "sess_child title");
  assert.equal(turnSource(session).kind, "session");
  assert.equal(turnSource(mine), undefined);
});
