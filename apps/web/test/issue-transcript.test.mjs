import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./bundler-resolve.mjs", import.meta.url);
const { issueTranscript } =
  await import("../src/features/issue-detail/issue-transcript.ts");
const { issueDisplayStatus, issueStatuses, statusMeta, blockedReasonMeta } =
  await import("../src/lib/issue-meta.ts");
const { applyFoundryStreamEvent, mergeLoadedFoundryData } =
  await import("../src/app/foundry-data-projection.ts");

test("Issue SSE updates immediately, deduplicates replay and survives an older HTTP snapshot", () => {
  const issue = { id: "i", workspaceId: "w", status: "pending" };
  const before = {
    workspace: { id: "w" },
    issues: [issue],
    runs: [],
    agentSessions: [],
  };
  const running = {
    ...issue,
    status: "in_progress",
    run: { id: "r", issueId: "i", status: "running", events: [] },
  };
  let data = applyFoundryStreamEvent(before, {
    type: "issue_updated",
    payload: running,
  });
  const streamed = {
    type: "issue_run_event",
    payload: {
      id: "s",
      runId: "r",
      label: "Response reset",
      detail: "Live answer",
    },
  };
  data = applyFoundryStreamEvent(data, streamed);
  assert.equal(data.issues[0].run.events[0].detail, "Live answer");
  assert.equal(applyFoundryStreamEvent(data, streamed), data);
  assert.equal(
    applyFoundryStreamEvent(data, {
      type: "issue_run_event",
      payload: { ...streamed.payload, runId: "foreign" },
    }),
    data,
  );
  assert.equal(
    applyFoundryStreamEvent(data, {
      type: "issue_updated",
      payload: { ...running, workspaceId: "foreign" },
    }),
    data,
  );
  assert.equal(mergeLoadedFoundryData(data, before).issues[0].run.id, "r");
  const oldRead = { ...before, issues: [running], runs: [running.run] };
  assert.equal(
    mergeLoadedFoundryData(data, oldRead).issues[0].run.events.length,
    1,
  );
  const done = {
    ...running,
    status: "verifying",
    run: { ...data.issues[0].run, status: "completed" },
    messages: [{ id: "answer", role: "assistant", text: "Done", runId: "r" }],
  };
  data = applyFoundryStreamEvent(data, {
    type: "issue_updated",
    payload: done,
  });
  const repaired = mergeLoadedFoundryData(data, oldRead);
  assert.equal(repaired.issues[0].status, "verifying");
  assert.equal(repaired.runs[0].status, "completed");
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

test("Issue history merges attempts, persisted steer and streaming deltas without repeating answers", () => {
  const first = {
    id: "first",
    issueId: "issue",
    startedAt: "2026-09-09T01:00:00Z",
    status: "completed",
    events: [
      { id: "tool", label: "Read", detail: "AGENTS.md" },
      { id: "s1", label: "Response reset", detail: "First answer" },
    ],
  };
  const current = {
    id: "second",
    issueId: "issue",
    startedAt: "2026-09-09T02:00:00Z",
    status: "running",
    events: [
      {
        id: "steer",
        label: "Steered into active turn",
        detail: "Also check mobile",
      },
      { id: "s2", label: "Response reset", detail: "Checking" },
      { id: "s3", label: "Response delta", detail: " mobile" },
    ],
  };
  const issue = {
    id: "issue",
    runtime: "claude",
    status: "in_progress",
    sourceInput: "Build the page",
    run: current,
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
      {
        id: "msg_steer",
        runId: "second",
        role: "user",
        text: "Also check mobile",
      },
    ],
  };
  const result = issueTranscript(issue, [
    current,
    { ...first, issueId: "other" },
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
      run: { ...current, status: "completed" },
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
    [first],
  );
  assert.equal(
    finished.some((m) => m.text === "Checking mobile"),
    false,
  );
  assert.equal(finished.filter((m) => m.text === "Mobile checked").length, 1);
});

test("a second-precision follow-up stays before its millisecond-precision run while streaming and after completion", () => {
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
    run: {
      id: "r",
      issueId: "i",
      status: "running",
      startedAt: "2026-09-09T07:32:34.306Z",
      events: [],
    },
  };
  const history = [
    {
      id: "old",
      issueId: "i",
      status: "failed",
      startedAt: "2026-09-09T13:39:00+08:00",
      error: "Old failure",
      events: [],
    },
  ];
  let data = { workspace: { id: "w" }, issues: [issue], runs: [issue.run] };
  for (const [id, label, detail, expected] of [
    ["chunk1", "Response reset", "Working", "Working"],
    ["chunk2", "Response delta", " on it", "Working on it"],
  ]) {
    data = applyFoundryStreamEvent(data, {
      type: "issue_run_event",
      payload: { id, runId: "r", label, detail },
    });
    const transcript = issueTranscript(data.issues[0], history);
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
      ...data.issues[0],
      status: "verifying",
      run: { ...data.issues[0].run, status: "completed" },
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
    history,
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
      run: {
        id: "r",
        issueId: "i",
        status,
        error: "Connection lost",
        events: [
          { id: "s", label: "Response reset", detail: "Partial answer" },
        ],
      },
    };
    assert.equal(issueDisplayStatus(issue), "blocked");
    const messages = issueTranscript(issue);
    assert.ok(
      messages.some((m) => m.text === "Partial answer" && !m.streaming),
    );
    assert.ok(messages.some((m) => m.kind === "failure" && m.recoverable));
  }
  assert.equal(
    statusMeta(issueDisplayStatus({ status: "blocked" })).label,
    "Blocked",
  );
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
  assert.equal(issueDisplayStatus({ status: "interrupted" }), "blocked");
  assert.equal(issueDisplayStatus({ status: "review" }), "verifying");
  assert.equal(issueDisplayStatus({ status: "integrated" }), "accepted");
});
