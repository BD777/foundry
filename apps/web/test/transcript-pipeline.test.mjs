import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register("./bundler-resolve.mjs", import.meta.url);
const { projectTranscript } =
  await import("../src/features/chat/transcript-projection.ts");
const { chatMessages, chatMessagesForThread } =
  await import("../src/features/chat/chat-model.ts");
const { chatMessagesForSubagentTranscript } =
  await import("../src/features/chat/chat-transcript-model.ts");
const { processDisplayRows } =
  await import("../src/components/conversation/chat-process-display.ts");

const { compactFoundryStreamEvents } =
  await import("../src/app/foundry-data-projection.ts");

test("transport batching never drops consecutive independent typed answers", () => {
  const packet = (id, text) => ({
    type: "agent_session_event",
    payload: {
      id: `event-${id}`,
      sessionId: "s",
      label: "Response stream",
      detail: text,
      message: { id, kind: "assistant", text },
    },
  });
  const events = compactFoundryStreamEvents([
    packet("a", "one"),
    packet("a", "one updated"),
    packet("b", "two"),
  ]);
  assert.deepEqual(
    events.map((e) => e.payload.message.text),
    ["one updated", "two"],
  );
});

const sequence = [
  {
    id: "reason",
    kind: "reasoning",
    text: "Summary\n\n### Literal heading",
    title: "思考完成",
  },
  {
    id: "call",
    kind: "tool",
    callId: "call",
    status: "running",
    title: "正在使用工具",
    text: 'Read\n\n```json\n{"path":"file"}\n```',
  },
  {
    id: "result",
    kind: "tool",
    callId: "call",
    status: "completed",
    title: "已使用工具",
    text: "File contents",
  },
  {
    id: "answer",
    kind: "assistant",
    text: "Answer\n\n```\nUser: literal\nCodex: literal\n```",
  },
  {
    id: "second-process",
    kind: "commentary",
    text: "One more check",
    title: "过程",
  },
  { id: "second-answer", kind: "assistant", text: "Further answer" },
];
const question = { id: "question", kind: "user", text: "Question" };
const signature = (messages) =>
  messages.map((m) => ({
    role: m.role,
    kind: m.kind,
    text: m.text,
    items: m.processItems?.map((i) => ({ title: i.title, detail: i.detail })),
  }));

for (const provider of ["claude", "codex"]) {
  test(`${provider}: managed, native and subagent replay share one projection`, () => {
    const expected = signature(projectTranscript([question, ...sequence]));
    const native = chatMessages({
      id: "native",
      provider,
      transcript: [question, ...sequence],
    });
    const managed = chatMessagesForThread({
      id: "thread",
      sessions: [
        {
          id: "session",
          provider,
          prompt: "Question",
          status: "completed",
          events: sequence.map((item) => ({
            id: item.id,
            label: item.kind === "assistant" ? "Response stream" : item.title,
            detail: item.text,
            message: item,
            level: "info",
            at: "2026-09-07T00:00:00Z",
          })),
        },
      ],
    });
    const subagent = chatMessagesForSubagentTranscript({
      taskId: "task",
      status: "completed",
      messages: [question, ...sequence].map((item) => ({
        ...item,
        content: item.text,
        role:
          item.kind === "user"
            ? "user"
            : item.kind === "tool"
              ? "tool"
              : "assistant",
      })),
    });
    for (const actual of [native, managed, subagent])
      assert.deepEqual(signature(actual), expected);
  });
}

test("group identity stays stable while streaming and when the answer arrives", () => {
  const initial = projectTranscript([{ ...sequence[0], streaming: true }]);
  const updating = projectTranscript([
    sequence[0],
    { ...sequence[1], streaming: true },
  ]);
  const completed = projectTranscript(sequence.slice(0, 4));
  assert.equal(initial.length, 1);
  assert.equal(initial[0].kind, "process");
  assert.equal(initial[0].id, updating[0].id);
  assert.equal(initial[0].id, completed[0].id);
  assert.equal(updating[0].streaming, true);
  assert.equal(completed[1].text, sequence[3].text);
});

test("headings remain content and tool completion preserves input, output and row identity", () => {
  const items = projectTranscript(sequence)[0].processItems;
  const startRows = processDisplayRows(items.slice(0, 2), true);
  const finalRows = processDisplayRows(items, false);
  assert.equal(finalRows.length, 2);
  assert.equal(finalRows[0].detail, sequence[0].text);
  assert.equal(finalRows[1].id, startRows[1].id);
  assert.match(finalRows[1].detail, /path/);
  assert.match(finalRows[1].detail, /File contents/);
});

test("user turns, boundaries and failures separate adjacent process groups", () => {
  const entries = [
    sequence[0],
    question,
    sequence[1],
    { id: "b", kind: "boundary", text: "New turn" },
    sequence[0],
    { id: "f", kind: "failure", text: "Interrupted" },
  ];
  assert.deepEqual(
    projectTranscript(entries).map((m) => m.kind),
    ["process", undefined, "process", "boundary", "process", "failure"],
  );
});

test("typed semantics take precedence over labels and preserve consecutive answers", () => {
  const answers = ["one", "two"].map((id) => ({
    id,
    label: "Loaded workspace",
    detail: "legacy",
    message: { id, kind: "assistant", text: id },
    at: "2026-09-07T00:00:00Z",
    level: "info",
  }));
  const messages = chatMessagesForThread({
    id: "t",
    sessions: [{ id: "s", prompt: "Q", status: "completed", events: answers }],
  });
  assert.deepEqual(
    messages.map((m) => m.text),
    ["Q", "one", "two"],
  );
});

test("legacy managed Claude still combines its existing process rows", () => {
  const messages = chatMessagesForThread({
    id: "t",
    sessions: [
      {
        id: "s",
        provider: "claude",
        prompt: "Q",
        status: "completed",
        events: [
          {
            id: "start",
            label: "正在使用工具",
            detail: 'Read\n\n```json\n{"path":"file"}\n```',
          },
          {
            id: "end",
            label: "已使用工具",
            detail: 'Read\n\n```json\n{"path":"file"}\n```',
          },
          { id: "answer", label: "Response stream", detail: "Answer" },
        ],
      },
    ],
  });
  assert.deepEqual(
    messages.map((m) => m.kind),
    [undefined, "process", undefined],
  );
  assert.equal(processDisplayRows(messages[1].processItems, false).length, 1);
  assert.equal(messages[2].text, "Answer");
});

test("bookkeeping after an answer never forms a process row of its own", () => {
  // The worker's records after a turn's answer, as a real chat stored them:
  // request usage, the turn's files, its finish, background-work and subagent
  // bookkeeping. Some arrive without their metadata (older workers).
  const at = (second) => `2026-10-10T01:00:${String(second).padStart(2, "0")}Z`;
  const sessionFile = (path) => ({
    sessionFile: {
      path: `/w/${path}`,
      workspacePath: path,
      origin: "reference",
      op: "referenced",
      inGitRepo: true,
      inputId: "in_1",
    },
  });
  const event = (id, second, label, detail = "", metadata, message) => ({
    id,
    at: at(second),
    label,
    detail,
    level: "info",
    sessionId: "s",
    ...(metadata ? { metadata } : {}),
    ...(message ? { message } : {}),
  });
  const running = {
    id: "a1",
    provider: "claude",
    kind: "subagent",
    description: "Stop writing scaffold",
    status: "running",
    startedAt: at(0),
    hasOutput: false,
  };
  const messages = chatMessagesForThread({
    id: "t",
    sessions: [
      {
        id: "s",
        provider: "claude",
        prompt: "Q",
        status: "completed",
        events: [
          event("input", 1, "User message", "", undefined, {
            id: "in_1",
            kind: "user",
            text: "Change it",
          }),
          event("think", 2, "Thinking", "Claude is processing the request."),
          event(
            "answer",
            30,
            "Response stream",
            "Done: the subagent is on it.",
          ),
          event("usage", 30, "Model request usage", "msg_1", {
            requestUsage: {
              requestId: "msg_1",
              inputTokens: 10,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 5,
            },
          }),
          event(
            "file1",
            31,
            "Recorded file",
            "AGENTS.md",
            sessionFile("AGENTS.md"),
          ),
          event(
            "file2",
            32,
            "Recorded file",
            "CONTEXT.md",
            sessionFile("CONTEXT.md"),
          ),
          event("finished", 33, "Claude Agent SDK finished", "/w/result.md", {
            turnUsage: {
              durationMs: 28000,
              inputTokens: 10,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 5,
              modelRequests: 1,
            },
          }),
          event("bg", 34, "Background tasks updated", running.description, {
            backgroundTaskSnapshot: [running],
          }),
          event("sub", 35, "Subtask running", "Running Read files", {
            taskId: "a1",
            toolUseId: "toolu_a1",
          }),
          // Older workers: the same bookkeeping without its metadata.
          event("file3", 36, "Recorded file", "AGENTS.md"),
          event("bg2", 37, "Background tasks updated", running.description),
          event("timers", 38, "Scheduled tasks updated", "Check CI hourly"),
          event("usage2", 39, "Model request usage", "msg_2"),
        ],
      },
    ],
  });
  assert.deepEqual(
    messages.map((m) => [m.role, m.kind]),
    [
      ["user", undefined],
      ["bot", "process"],
      ["bot", undefined],
    ],
  );
  const answer = messages.at(-1);
  assert.equal(answer.text, "Done: the subagent is on it.");
  assert.equal(answer.usage?.durationMs, 28000);
  assert.deepEqual(answer.turnFiles, { turnId: "in_1", count: 2 });
});

// Trimmed from sess_1791538912480523679: a message steered in while a tool
// runs puts that call's start and its result in two groups. Rows are keyed by
// id, and a repeated key left stale copies of the row and blank space.
test("a tool call split by a steered message gives each group its own row id", () => {
  const turn = "b4342dd2-a503-4bc3-bb43-6b022dc476e4";
  const call = (id, at, label, status) => ({
    id: `evt_${id}`,
    at,
    label,
    detail: "Bash",
    level: "info",
    message: {
      id: `${turn}/call_144`,
      kind: "tool",
      text: "Bash",
      title: label,
      callId: "call_144",
      status,
    },
  });
  const plain = (id, at, label, detail) => ({
    id: `evt_${id}`,
    at,
    label,
    detail,
    level: "info",
  });
  const messages = chatMessagesForThread({
    id: "thread",
    sessions: [
      {
        id: "s",
        provider: "claude",
        prompt: "Look at the meego tools",
        status: "running",
        events: [
          plain(
            "answer_21",
            "2026-10-14T08:21:02Z",
            "Response stream",
            "Another way.",
          ),
          call("i236", "2026-10-14T08:21:02Z", "Using tool", "running"),
          call("iuv1", "2026-10-14T08:21:04Z", "Using tool", "running"),
          plain(
            "steer",
            "2026-10-14T08:21:54Z",
            "Steered into active turn",
            "I'm here now",
          ),
          call("7tjj", "2026-10-14T08:22:04Z", "Tool failed", "failed"),
          plain(
            "xx4v",
            "2026-10-14T08:22:05Z",
            "Requesting model",
            "Claude is generating a response.",
          ),
          plain(
            "answer_22",
            "2026-10-14T08:22:30Z",
            "Response stream",
            "Here is the link.",
          ),
        ],
      },
    ],
  });
  const ids = messages.map((message) => message.id);
  assert.equal(new Set(ids).size, ids.length, ids.join("\n"));
  const steer = ids.indexOf("agent-session:s:evt_steer");
  assert.equal(messages[steer - 1].kind, "process");
  assert.equal(messages[steer + 1].kind, "process");
});

test("cumulative commentary updates replace the same native message without merging distinct messages", async () => {
  const { sessionTranscriptEntries } =
    await import("../src/features/chat/transcript-adapters.ts");
  const event = (id, messageId, text, kind = "commentary") => ({
    id,
    sessionId: "s",
    at: "2026-10-16T03:24:38Z",
    label: "Commentary",
    level: "info",
    detail: text,
    message: { id: messageId, kind, text },
  });
  const entries = sessionTranscriptEntries({
    id: "s",
    status: "running",
    provider: "codex",
    events: [
      event("e1", "input1/msg1", "我先看"),
      event("e2", "input1/msg1", "我先看看已有资料"),
      event("tool", "call1", "读取目录", "tool"),
      event("e3", "input1/msg1", "我先看看已有资料，再搭建阅读站。"),
      event("e4", "input1/msg2", "另一段独立说明"),
      event("e5", "input2/msg1", "新一轮的说明"),
    ],
  });
  const comments = entries.filter((e) => e.kind === "commentary");
  assert.deepEqual(
    comments.map((e) => e.text),
    ["我先看看已有资料，再搭建阅读站。", "另一段独立说明", "新一轮的说明"],
  );
  assert.equal(comments[0].stepId, "agent-session:s:e1");
  assert.equal(entries[0], comments[0]);
  assert.equal(entries[1].kind, "tool");
});

test("commentary streams as body text between independent thinking and tool groups", () => {
  const commentary = {
    id: "commentary",
    kind: "commentary",
    title: "Process",
    text: "已安排只重启 **linux-dev** 的控制 worker。",
    streaming: true,
  };
  const rows = projectTranscript([sequence[0], commentary]);
  assert.equal(rows[0].kind, "process");
  assert.equal(rows[1].kind, undefined);
  assert.equal(rows[1].role, "bot");
  assert.equal(rows[1].streaming, true);
  assert.equal(rows[1].text, commentary.text);
  assert.equal(rows[1].processItems, undefined);
  const settled = projectTranscript([
    sequence[0],
    {
      ...commentary,
      streaming: false,
      text: `${commentary.text}\n\n再检查兼容性。`,
    },
    sequence[1],
    sequence[2],
    sequence[3],
  ]);
  assert.deepEqual(
    settled.map((row) => row.kind),
    ["process", undefined, "process", undefined],
  );
  assert.equal(settled[1].id, rows[1].id);
  assert.equal(settled[1].streaming, false);
  assert.equal(settled[2].processItems.length, 2);
});
