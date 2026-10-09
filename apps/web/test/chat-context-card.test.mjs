import assert from "node:assert/strict";
import test from "node:test";
import { chatContextCardForSessions } from "../src/features/chat/chat-context-model.ts";
import { shouldDisplayResponseEvent } from "../src/features/chat/subagent-response-filter.ts";

function event(id, label, detail, level = "info", metadata) {
  return {
    at: "2026-08-01T00:00:00.000Z",
    detail,
    id,
    label,
    level,
    metadata,
    sessionId: "sess_test",
  };
}

function subagentEvent(id, label, detail, taskId) {
  return event(id, label, detail, "info", {
    taskId,
    taskType: "local_agent",
    toolUseId: `tool_${taskId}`,
  });
}

function session(events, status = "running") {
  return {
    agentId: "agent_test",
    createdLabel: "just now",
    deviceId: "dev_test",
    events,
    id: "sess_test",
    prompt: "hello",
    provider: "claude",
    status,
    title: "hello",
    updatedLabel: status,
    workspaceId: "ws_test",
  };
}

test("projects output, subagents, and workspace source into the sidecar", () => {
  const data = chatContextCardForSessions([
    session([
      event("evt_workspace", "Loaded workspace", "/tmp/project"),
      subagentEvent(
        "evt_start_1",
        "正在启动子任务",
        "Fetch messages",
        "task_1",
      ),
      subagentEvent("evt_done_1", "子任务完成", "Fetch messages", "task_1"),
      subagentEvent(
        "evt_start_2",
        "正在启动子任务",
        "Summarize messages",
        "task_2",
      ),
      event(
        "evt_output",
        "Claude Agent SDK finished",
        "/tmp/project/result.md",
      ),
    ]),
  ]);

  // A turn's result.md is Foundry's copy of the reply already in the chat.
  assert.deepEqual(data?.previews, []);
  assert.deepEqual([...data.changes, ...data.files], []);
  assert.deepEqual(
    data?.subagents.map((item) => [item.label, item.status]),
    [
      ["Fetch messages", "completed"],
      ["Summarize messages", "running"],
    ],
  );
  assert.deepEqual(data?.sources, [
    {
      detail: "/tmp/project",
      id: "evt_workspace",
      kind: "source",
      label: "/tmp/project",
      target: "/tmp/project",
      workspaceId: "ws_test",
    },
  ]);
});

test("projects initial active workspace source in a fresh session without events", () => {
  const data = chatContextCardForSessions(
    [],
    {},
    {
      id: "ws_initial",
      localPath: "/Users/you/workspace",
      name: "workspace",
    },
  );

  assert.deepEqual(data?.previews, []);
  assert.deepEqual(data?.changes, []);
  assert.deepEqual(data?.files, []);
  assert.deepEqual(data?.subagents, []);
  assert.deepEqual(data?.timers, []);
  assert.deepEqual(data?.sources, [
    {
      detail: "/Users/you/workspace",
      id: "workspace_source_ws_initial",
      kind: "source",
      label: "/Users/you/workspace",
      target: "/Users/you/workspace",
      workspaceId: "ws_initial",
    },
  ]);
});

test("does not invent a terminal subagent status from the parent session", () => {
  const completed = chatContextCardForSessions([
    session(
      [
        subagentEvent(
          "evt_start",
          "正在启动子任务",
          "Analyze repository",
          "task_1",
        ),
      ],
      "completed",
    ),
  ]);
  const failed = chatContextCardForSessions([
    session(
      [
        subagentEvent(
          "evt_start",
          "正在启动子任务",
          "Analyze repository",
          "task_1",
        ),
      ],
      "failed",
    ),
  ]);

  assert.equal(completed?.subagents[0]?.status, "running");
  assert.equal(failed?.subagents[0]?.status, "failed");
});

test("merges subagent status monotonically using raw transcript state", () => {
  const item = session([
    subagentEvent(
      "evt_start",
      "正在启动子任务",
      "Analyze repository",
      "task_1",
    ),
  ]);
  const completed = chatContextCardForSessions([item], {
    [item.id]: [
      {
        prompt: "Inspect the bug",
        responseTexts: ["Done"],
        sessionId: item.id,
        status: "completed",
        taskId: "task_1",
        title: "Analyze repository",
        toolUseId: "tool_task_1",
      },
    ],
  });
  assert.equal(completed?.subagents[0]?.status, "completed");

  item.events.push(
    subagentEvent("evt_done", "子任务完成", "Analyze repository", "task_1"),
  );
  const staleDiscovery = chatContextCardForSessions([item], {
    [item.id]: [
      {
        responseTexts: [],
        sessionId: item.id,
        status: "running",
        taskId: "task_1",
        title: "Analyze repository",
        toolUseId: "tool_task_1",
      },
    ],
  });
  assert.equal(staleDiscovery?.subagents[0]?.status, "completed");
});

test("keeps the sidecar focused on the most recent turn with agent activity", () => {
  const older = session(
    [
      subagentEvent(
        "evt_old_start",
        "正在启动子任务",
        "Older task",
        "task_old",
      ),
      subagentEvent("evt_old_done", "子任务完成", "Older task", "task_old"),
      event("evt_old_output", "Produced output file", "old.md", "info", {
        outputFile: "old.md",
      }),
    ],
    "completed",
  );
  older.id = "sess_old";
  const newer = session(
    [
      subagentEvent(
        "evt_new_start",
        "正在启动子任务",
        "Current task",
        "task_new",
      ),
      event("evt_new_output", "Produced output file", "new.md", "info", {
        outputFile: "new.md",
      }),
    ],
    "completed",
  );
  newer.id = "sess_new";

  const data = chatContextCardForSessions([older, newer]);

  assert.deepEqual(
    data?.subagents.map((item) => item.label),
    ["Current task"],
  );
  // Older workers credited any changed file as outputFile: never shown.
  assert.deepEqual([...data.changes, ...data.files], []);
});

test("does not present background bash work as a subagent", () => {
  const data = chatContextCardForSessions([
    session([
      event("evt_workspace", "Loaded workspace", "/tmp/project"),
      event("evt_bash", "正在启动子任务", "Fetch messages", "info", {
        taskId: "task_bash",
        taskType: "local_bash",
      }),
    ]),
  ]);

  assert.deepEqual(data?.subagents, []);
});

test("recovers historical subagents when persisted lifecycle metadata is missing", () => {
  const item = session(
    [
      event("evt_workspace", "Loaded workspace", "/tmp/project"),
      event(
        "evt_output",
        "Claude Agent SDK finished",
        "/tmp/project/result.md",
      ),
    ],
    "completed",
  );
  const data = chatContextCardForSessions([item], {
    [item.id]: [
      {
        prompt: "Inspect the bug",
        responseTexts: ["Subagent answer"],
        sessionId: item.id,
        status: "completed",
        subagentType: "general-purpose",
        taskId: "task_agent",
        title: "Inspect workspace",
        toolUseId: "tool_agent",
      },
    ],
  });

  assert.deepEqual(
    data?.subagents.map(({ label, status, taskId }) => [label, status, taskId]),
    [["Inspect workspace", "completed", "task_agent"]],
  );
});

test("suppresses historical forwarded subagent body but keeps the parent final", () => {
  const suppressed = new Set(["Subagent answer", "Parent answer"]);
  assert.equal(
    shouldDisplayResponseEvent(
      "evt_child",
      "Subagent answer",
      "evt_parent",
      suppressed,
    ),
    false,
  );
  assert.equal(
    shouldDisplayResponseEvent(
      "evt_parent",
      "Parent answer",
      "evt_parent",
      suppressed,
    ),
    true,
  );
});

test("projects preview urls as web resources", () => {
  const item = session([
    event("evt_workspace", "Loaded workspace", "/tmp/project"),
    event("evt_output", "command finished", "http://127.0.0.1:4173/dashboard"),
  ]);
  item.response = "Preview ready at http://127.0.0.1:4173/dashboard";

  const data = chatContextCardForSessions([item]);

  assert.deepEqual(
    data?.previews.map(({ kind, target }) => [kind, target]),
    [["web", "http://127.0.0.1:4173/dashboard"]],
  );
});

test("does not turn arbitrary response links into workspace previews", () => {
  const item = session([
    event("evt_workspace", "Loaded workspace", "/tmp/project"),
  ]);
  item.response = "See https://example.com/reference for more information";

  const data = chatContextCardForSessions([item]);

  assert.deepEqual(data?.previews, []);
});

function recorded(id, file) {
  return event(id, "Recorded file", file.workspacePath ?? file.path, "info", {
    sessionFile: file,
  });
}

test("lists the chat's recorded files in Changes and Files, never legacy guesses", () => {
  const first = session([
    event("evt_workspace", "Loaded workspace", "/home/me/repo"),
    // An older worker credited every file that changed while it ran.
    event("evt_legacy", "Produced output file", "unrelated.go", "info", {
      outputFile: "unrelated.go",
    }),
    recorded("evt_plan", {
      path: "/home/me/repo/docs/plan.md",
      workspacePath: "docs/plan.md",
      origin: "tool",
      op: "created",
      inGitRepo: true,
      inputId: "in_1",
      agent: "main",
    }),
    recorded("evt_report", {
      path: "/tmp/fdy-groupscan/products/omh.md",
      origin: "tool",
      op: "created",
      inGitRepo: false,
      inputId: "in_1",
      agent: "agent_7",
    }),
  ]);
  const second = session([
    recorded("evt_plan_again", {
      path: "/home/me/repo/docs/plan.md",
      workspacePath: "docs/plan.md",
      origin: "tool",
      op: "modified",
      inGitRepo: true,
      inputId: "in_2",
      agent: "main",
    }),
    recorded("evt_named", {
      path: "/tmp/fdy-groupscan/products/rev.md",
      origin: "reference",
      op: "referenced",
      inGitRepo: false,
      inputId: "in_2",
      agent: "main",
    }),
    // Named by the answer inside the repository, never edited: a file to
    // open, not a change.
    recorded("evt_named_in_repo", {
      path: "/home/me/repo/README.md",
      workspacePath: "README.md",
      origin: "reference",
      op: "referenced",
      inGitRepo: true,
      inputId: "in_2",
      agent: "main",
    }),
  ]);
  second.id = "sess_second";

  const data = chatContextCardForSessions(
    [first, second],
    {},
    {
      id: "ws_test",
      localPath: "/home/me/repo",
      deviceLabel: "Laptop",
    },
  );

  assert.deepEqual(
    data.changes.map(({ path, op, origin, turnIds, sessionId }) => [
      path,
      op,
      origin,
      turnIds,
      sessionId,
    ]),
    [
      [
        "/home/me/repo/docs/plan.md",
        "created",
        "tool",
        ["in_1", "in_2"],
        "sess_second",
      ],
    ],
  );
  assert.deepEqual(
    data.files.map(({ label, origin, turnIds, deviceLabel }) => [
      label,
      origin,
      turnIds,
      deviceLabel,
    ]),
    [
      ["README.md", "reference", ["in_2"], "Laptop"],
      ["omh.md", "tool", ["in_1"], "Laptop"],
      ["rev.md", "reference", ["in_2"], "Laptop"],
    ],
  );
});

test("each answer carries its turn's file count and verified references", async () => {
  const { chatMessagesForThread } =
    await import("../src/features/chat/chat-model.ts");
  const at = (second) =>
    `2026-10-09T01:00:${String(second).padStart(2, "0")}.000Z`;
  const turn = (inputId, second, files, references) => [
    {
      ...event(`evt_${inputId}`, "User message", ""),
      at: at(second),
      message: { id: inputId, kind: "user", text: "write" },
    },
    ...files.map((path, index) =>
      recordedAt(`evt_${inputId}_${index}`, at(second + 1), {
        path,
        origin: "tool",
        op: "created",
        inGitRepo: false,
        inputId,
        agent: "main",
      }),
    ),
    {
      ...event(`evt_${inputId}_answer`, "Response stream", ""),
      at: at(second + 2),
      message: { id: `a_${inputId}`, kind: "assistant", text: "done" },
    },
    {
      ...event(
        `evt_${inputId}_done`,
        "Claude Agent SDK finished",
        "/tmp/result.md",
        "info",
        references ? { fileReferences: references } : undefined,
      ),
      at: at(second + 3),
    },
  ];
  function recordedAt(id, when, file) {
    return { ...recorded(id, file), at: when };
  }
  const reference = { text: "a.md", path: "/tmp/out/a.md", kind: "file" };
  const item = session(
    [
      ...turn(
        "in_1",
        0,
        ["/tmp/out/a.md", "/tmp/out/b.md", "/tmp/out/a.md"],
        [reference],
      ),
      ...turn("in_2", 10, []),
    ],
    "completed",
  );
  const answers = chatMessagesForThread({
    id: "t",
    sessions: [item],
    title: "t",
  }).filter((message) => message.role === "bot" && !message.kind);
  assert.deepEqual(
    answers.map((answer) => [answer.turnFiles, answer.fileReferences]),
    [
      [{ turnId: "in_1", count: 2 }, [reference]],
      [undefined, undefined],
    ],
  );
});
