import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./bundler-resolve.mjs", import.meta.url);
const { issueTranscript } =
  await import("../src/features/issue-detail/issue-transcript.ts");
const { issueBadgeMeta, issueStatuses, statusMeta, blockedReasonMeta } =
  await import("../src/lib/issue-meta.ts");
const { applyFoundryStreamEvent, mergeLoadedFoundryData } =
  await import("../src/app/foundry-data-projection.ts");
const { mergeAgentSessionEvent } =
  await import("../src/lib/agent-session-events.ts");
const { sessionTranscriptItems } =
  await import("../src/features/chat/thread/chat-message-items.ts");

test("Issue SSE updates immediately and survives an older HTTP snapshot", () => {
  const issue = { id: "i", workspaceId: "w", status: "pending" };
  const before = { workspace: { id: "w" }, issues: [issue], agentSessions: [] };
  const running = {
    ...issue,
    status: "in_progress",
    run: { id: "r", status: "running" },
  };
  let data = applyFoundryStreamEvent(before, {
    type: "issue_updated",
    payload: running,
  });
  assert.equal(data.issues[0].run.id, "r");
  assert.equal(
    applyFoundryStreamEvent(data, {
      type: "issue_updated",
      payload: { ...running, workspaceId: "foreign" },
    }),
    data,
  );
  assert.equal(mergeLoadedFoundryData(data, before).issues[0].run.id, "r");
  const oldRead = { ...before, issues: [running] };
  const done = {
    ...running,
    status: "verifying",
    run: { id: "r", status: "completed" },
    messages: [{ id: "answer", role: "assistant", text: "Done", runId: "r" }],
  };
  data = applyFoundryStreamEvent(data, {
    type: "issue_updated",
    payload: done,
  });
  const repaired = mergeLoadedFoundryData(data, oldRead);
  assert.equal(repaired.issues[0].status, "verifying");
  assert.equal(repaired.issues[0].run.status, "completed");
  assert.equal(repaired.issues[0].messages[0].text, "Done");
  for (const status of ["accepted", "abandoned"]) {
    const terminal = applyFoundryStreamEvent(data, {
      type: "issue_updated",
      payload: { ...done, status },
    });
    const stale = mergeLoadedFoundryData(terminal, {
      ...oldRead,
      issues: [done],
    });
    assert.equal(
      stale.issues[0].status,
      status,
      "old review reads cannot revive terminal Issues",
    );
  }
});

/** An Issue's execution session with its events, as the server reads it. */
const execution = (id, issueId, startedAt, status, events, error) => ({
  id,
  issueId,
  role: "issue_execution",
  provider: "claude",
  startedAt,
  status,
  error,
  input: { id: `${id}_input`, prompt: "Implement ISS-1" },
  events: [
    {
      id: `evt_${id}_input`,
      at: startedAt,
      label: "User message",
      detail: "Implement ISS-1",
      message: {
        id: `${id}_input`,
        at: startedAt,
        kind: "user",
        text: "Implement ISS-1",
      },
    },
    ...events,
  ].map((event) => ({ sessionId: id, level: "info", ...event })),
});
const answer = (id, text, at) => ({
  id,
  at,
  label: "Response stream",
  detail: text,
});
const plain = (messages) =>
  messages
    .filter((m) => !m.kind && typeof m.text === "string")
    .map((m) => m.text);

test("an Issue's executions show as a chat shows their sessions, among the Issue's own messages", () => {
  const first = execution(
    "first",
    "issue",
    "2026-09-09T01:00:00Z",
    "completed",
    [
      {
        id: "tool",
        at: "2026-09-09T01:00:01Z",
        label: "Read project instructions",
        detail: "AGENTS.md",
      },
      answer("evt_first_answer", "First answer", "2026-09-09T01:00:02Z"),
    ],
  );
  const current = execution(
    "second",
    "issue",
    "2026-09-09T02:00:00Z",
    "running",
    [
      {
        id: "evt_steer",
        at: "2026-09-09T02:00:01Z",
        label: "Steered into active turn",
        detail: "Also check mobile",
        message: {
          id: "steer",
          at: "2026-09-09T02:00:01Z",
          kind: "user",
          text: "Also check mobile",
        },
      },
      answer("evt_second_answer", "Checking mobile", "2026-09-09T02:00:02Z"),
    ],
  );
  const issue = {
    id: "issue",
    runtime: "claude",
    status: "in_progress",
    sourceInput: "Build the page",
    run: { id: "second", status: "running" },
    messages: [
      // The Issue's copy of an execution's answer is the session's to show.
      {
        id: "msg_first",
        runId: "first",
        role: "assistant",
        text: "First answer",
        createdAt: "2026-09-09T01:00:03Z",
      },
      {
        id: "feedback",
        role: "user",
        text: "Refine layout",
        createdAt: "2026-09-09T01:30:00Z",
      },
      {
        id: "question_1",
        runId: "second",
        role: "assistant",
        text: "Which breakpoint?",
        createdAt: "2026-09-09T02:00:03Z",
      },
    ],
  };
  const result = issueTranscript(
    issue,
    [current, { ...first, id: "foreign", issueId: "other" }, first],
    (sessions) => sessionTranscriptItems(sessions),
  );
  assert.deepEqual(plain(result), [
    "Build the page",
    "Implement ISS-1",
    "First answer",
    "Refine layout",
    "Implement ISS-1",
    "Also check mobile",
    "Checking mobile",
    "Which breakpoint?",
  ]);
  assert.equal(
    result.find((m) => m.text === "Checking mobile").streaming,
    false,
    "an answer that streams shows its text; the running turn shows below",
  );
  assert.ok(
    result.some(
      (m) =>
        m.kind === "process" &&
        m.processItems?.some((item) => item.detail === "AGENTS.md"),
    ),
  );
  assert.equal(
    result.some((m) => m.id === "issue:working"),
    false,
    "a running execution shows its own progress",
  );
  // Claimed, its execution not read yet: the Issue says it works.
  assert.ok(
    issueTranscript(issue, [], (sessions) =>
      sessionTranscriptItems(sessions),
    ).some((m) => m.id === "issue:working"),
  );
});

test("a second-precision follow-up stays before its millisecond-precision execution while streaming and after completion", () => {
  const issue = {
    id: "i",
    runtime: "claude",
    status: "in_progress",
    sourceInput: "hi",
    messages: [
      {
        id: "followup",
        role: "user",
        text: "继续",
        createdAt: "2026-09-09T07:32:34Z",
      },
    ],
    run: { id: "r", status: "running" },
  };
  const old = execution(
    "old",
    "i",
    "2026-09-09T05:39:00Z",
    "failed",
    [],
    "Old failure",
  );
  let current = execution("r", "i", "2026-09-09T07:32:34.306Z", "running", []);
  for (const [text, expected] of [
    ["Working", "Working"],
    ["Working on it", "Working on it"],
  ]) {
    current = {
      ...current,
      events: mergeAgentSessionEvent(current.events, {
        ...answer("evt_r_input_response_stream", text, "2026-09-09T07:32:35Z"),
        sessionId: "r",
        level: "info",
      }),
    };
    const transcript = issueTranscript(issue, [old, current], (sessions) =>
      sessionTranscriptItems(sessions),
    );
    assert.deepEqual(plain(transcript), [
      "hi",
      "Implement ISS-1",
      "继续",
      "Implement ISS-1",
      expected,
    ]);
    assert.ok(
      transcript.findIndex((m) => m.kind === "failure") <
        transcript.findIndex((m) => m.id === "followup"),
    );
  }
  const finished = issueTranscript(
    {
      ...issue,
      status: "verifying",
      run: { id: "r", status: "completed" },
      messages: [
        ...issue.messages,
        {
          id: "msg_r",
          runId: "r",
          role: "assistant",
          text: "Working on it",
          createdAt: "2026-09-09T07:40:00Z",
        },
      ],
    },
    [old, { ...current, status: "completed" }],
    (sessions) => sessionTranscriptItems(sessions),
  );
  assert.deepEqual(plain(finished), [
    "hi",
    "Implement ISS-1",
    "继续",
    "Implement ISS-1",
    "Working on it",
  ]);
});

test("an interrupted execution keeps its partial answer and an Issue blocked on it says why", () => {
  for (const status of ["failed", "canceled"]) {
    const issue = {
      id: "i",
      runtime: "codex",
      status: "blocked",
      sourceInput: "Goal",
      run: { id: "r", status, error: "Connection lost" },
    };
    const messages = issueTranscript(
      issue,
      [
        execution(
          "r",
          "i",
          "2026-09-09T01:00:00Z",
          status,
          [answer("s", "Partial answer", "2026-09-09T01:00:01Z")],
          "Connection lost",
        ),
      ],
      (sessions) => sessionTranscriptItems(sessions),
    );
    assert.ok(
      messages.some((m) => m.text === "Partial answer" && !m.streaming),
    );
  }
  // A blocked Issue's badge says why, and waiting for a reply is not an alarm.
  for (const [kind, label, tone] of [
    ["needs_input", "Needs your reply", "brass"],
    ["needs_permission", "Needs permission", "warn"],
    ["system_error", "Needs attention", "error"],
  ])
    assert.deepEqual(
      issueBadgeMeta({
        status: "blocked",
        blockedReason: { kind, message: "m" },
      }),
      { label, tone },
    );
  assert.deepEqual(
    issueBadgeMeta({ status: "verifying" }),
    statusMeta("verifying"),
  );
  assert.equal(statusMeta("blocked").label, "Blocked");
  assert.equal(new Set(issueStatuses).size, 6);
  for (const status of issueStatuses) assert.ok(statusMeta(status).label);
  for (const [kind, label] of [
    ["needs_input", "Needs input"],
    ["needs_permission", "Needs permission"],
    ["system_error", "System error"],
  ]) {
    assert.deepEqual(
      blockedReasonMeta({
        status: "blocked",
        blockedReason: { kind, message: "Specific next action" },
      }),
      { label, message: "Specific next action" },
    );
  }
});

test("a message from a Feishu thread says so in the Issue conversation", () => {
  const messages = issueTranscript(
    {
      id: "i",
      runtime: "claude",
      sourceInput: "Add usage",
      messages: [
        {
          id: "clarify_1",
          role: "user",
          text: "For new users",
          createdAt: "2026-10-03T01:00:00Z",
          via: "feishu",
        },
        {
          id: "clarify_2",
          role: "assistant",
          text: "Which file?",
          createdAt: "2026-10-03T01:00:05Z",
        },
        {
          id: "clarify_3",
          role: "user",
          text: "README.md",
          createdAt: "2026-10-03T01:00:09Z",
        },
      ],
    },
    [],
    (sessions) => sessionTranscriptItems(sessions),
  );
  const origins = Object.fromEntries(messages.map((m) => [m.id, m.origin]));
  assert.equal(origins.clarify_1, "via Feishu");
  assert.equal(origins.clarify_2, undefined);
  assert.equal(origins.clarify_3, undefined);
});
