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

/** An Issue's execution session with its events. */
const execution = (id, issueId, startedAt, status, events, error) => ({
  id,
  issueId,
  role: "issue_execution",
  startedAt,
  status,
  error,
  events: events.map((event) => ({ sessionId: id, level: "info", ...event })),
});

test("Issue executions merge into one conversation with steer and streaming deltas, without repeating answers", () => {
  const first = execution(
    "first",
    "issue",
    "2026-09-09T01:00:00Z",
    "completed",
    [
      { id: "tool", label: "Read", detail: "AGENTS.md" },
      { id: "s1", label: "Response reset", detail: "First answer" },
    ],
  );
  const current = execution(
    "second",
    "issue",
    "2026-09-09T02:00:00Z",
    "running",
    [
      {
        id: "steer",
        label: "Steered into active turn",
        detail: "Also check mobile",
      },
      { id: "s2", label: "Response reset", detail: "Checking" },
      { id: "s3", label: "Response delta", detail: " mobile" },
    ],
  );
  const issue = {
    id: "issue",
    runtime: "claude",
    status: "in_progress",
    sourceInput: "Build the page",
    run: { id: "second", status: "running" },
    messages: [
      {
        id: "answer1",
        runId: "first",
        role: "assistant",
        text: "First answer",
      },
      {
        id: "feedback",
        role: "user",
        text: "Refine layout",
        createdAt: "2026-09-09T01:30:00Z",
      },
    ],
  };
  const result = issueTranscript(issue, [
    current,
    { ...first, id: "foreign", issueId: "other" },
    first,
  ]);
  assert.deepEqual(
    result.filter((m) => !m.kind).map((m) => m.text),
    [
      "Build the page",
      "First answer",
      "Refine layout",
      "Also check mobile",
      "Checking mobile",
    ],
  );
  assert.equal(result.filter((m) => m.text === "First answer").length, 1);
  assert.equal(result.find((m) => m.id === "second:response").streaming, true);
  assert.equal(
    result.find((m) => m.kind === "process").processItems[0].detail,
    "AGENTS.md",
  );
  const finished = issueTranscript(
    {
      ...issue,
      status: "verifying",
      run: { id: "second", status: "completed" },
      messages: [
        ...issue.messages,
        {
          id: "answer2",
          runId: "second",
          role: "assistant",
          text: "Mobile checked",
        },
      ],
    },
    [first, current],
  );
  assert.equal(
    finished.some((m) => m.text === "Checking mobile"),
    false,
  );
  assert.equal(finished.filter((m) => m.text === "Mobile checked").length, 1);
  assert.equal(
    finished.filter((m) => m.text === "Also check mobile").length,
    1,
    "a steer shows once, from its execution",
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
    "2026-09-09T13:39:00+08:00",
    "failed",
    [],
    "Old failure",
  );
  let current = execution("r", "i", "2026-09-09T07:32:34.306Z", "running", []);
  for (const [id, label, detail, expected] of [
    ["chunk1", "Response reset", "Working", "Working"],
    ["chunk2", "Response delta", " on it", "Working on it"],
  ]) {
    current = {
      ...current,
      events: mergeAgentSessionEvent(current.events, {
        id,
        sessionId: "r",
        label,
        detail,
        level: "info",
      }),
    };
    const transcript = issueTranscript(issue, [old, current]);
    assert.deepEqual(
      transcript.filter((m) => !m.kind).map((m) => m.text),
      ["hi", "继续", expected],
    );
    assert.ok(
      transcript.findIndex((m) => m.kind === "failure") <
        transcript.findIndex((m) => m.id === "followup"),
    );
    assert.equal(transcript.find((m) => m.id === "r:response").streaming, true);
  }
  const finished = issueTranscript(
    {
      ...issue,
      status: "verifying",
      run: { id: "r", status: "completed" },
      messages: [
        ...issue.messages,
        {
          id: "final",
          runId: "r",
          role: "assistant",
          text: "Done",
          createdAt: "2026-09-09T07:40:00Z",
        },
      ],
    },
    [old, current],
  );
  assert.deepEqual(
    finished.filter((m) => !m.kind).map((m) => m.text),
    ["hi", "继续", "Done"],
  );
});

test("interruption retains partial output and represents execution failure as Blocked with a reason", () => {
  for (const status of ["failed", "canceled"]) {
    const issue = {
      id: "i",
      runtime: "codex",
      status: "blocked",
      sourceInput: "Goal",
      run: { id: "r", status, error: "Connection lost" },
    };
    const messages = issueTranscript(issue, [
      execution("r", "i", "2026-09-09T01:00:00Z", "running", [
        { id: "s", label: "Response reset", detail: "Partial answer" },
      ]),
    ]);
    assert.ok(
      messages.some((m) => m.text === "Partial answer" && !m.streaming),
    );
    const failure = messages.find((m) => m.kind === "failure");
    assert.ok(failure?.recoverable);
    // Why, what it means and what to do, with the reason last.
    assert.match(failure.text, /The candidate files are kept/);
    assert.match(failure.text, /Reason: Connection lost$/);
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
  const messages = issueTranscript({
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
  });
  const origins = Object.fromEntries(messages.map((m) => [m.id, m.origin]));
  assert.equal(origins.clarify_1, "via Feishu");
  assert.equal(origins.clarify_2, undefined);
  assert.equal(origins.clarify_3, undefined);
});
