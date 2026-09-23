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

  assert.deepEqual(data?.outputs, [
    {
      detail: "/tmp/project/result.md",
      id: "evt_output",
      kind: "file",
      label: "result.md",
      target: "/tmp/project/result.md",
      workspaceId: "ws_test",
    },
  ]);
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

  assert.deepEqual(data?.outputs, []);
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
      event(
        "evt_old_output",
        "Claude Agent SDK finished",
        "/tmp/old/result.md",
      ),
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
      event(
        "evt_new_output",
        "Claude Agent SDK finished",
        "/tmp/new/result.md",
      ),
    ],
    "completed",
  );
  newer.id = "sess_new";

  const data = chatContextCardForSessions([older, newer]);

  assert.deepEqual(
    data?.subagents.map((item) => item.label),
    ["Current task"],
  );
  assert.deepEqual(
    data?.outputs.map((item) => item.detail),
    ["/tmp/new/result.md"],
  );
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
    data?.outputs.map(({ kind, target }) => [kind, target]),
    [["web", "http://127.0.0.1:4173/dashboard"]],
  );
});

test("does not turn arbitrary response links into workspace previews", () => {
  const item = session([
    event("evt_workspace", "Loaded workspace", "/tmp/project"),
  ]);
  item.response = "See https://example.com/reference for more information";

  const data = chatContextCardForSessions([item]);

  assert.deepEqual(data?.outputs, []);
});

test("projects the files a run reported, never file names merely mentioned in its reply", () => {
  const item = session([
    event("evt_workspace", "Loaded workspace", "/tmp/project"),
    event(
      "evt_file_1",
      "Produced output file",
      "地狱焚决群增量总结-20260916-0922.md",
      "info",
      { outputFile: "地狱焚决群增量总结-20260916-0922.md" },
    ),
    event(
      "evt_file_2",
      "Produced output file",
      "summary-parts/01-06.md",
      "info",
      {
        outputFile: "summary-parts/01-06.md",
      },
    ),
    event("evt_output", "Claude Agent SDK finished", "/tmp/project/result.md"),
  ]);
  item.response = `现在目录下共三档粒度可选:
- 极简版: 地狱焚决群增量总结-20260916-0922.md
- 详版: summary-parts/01-06.md
另见 package.json`;

  const data = chatContextCardForSessions([item]);

  assert.deepEqual(
    data?.outputs.map(({ label, target }) => [label, target]),
    [
      ["01-06.md", "summary-parts/01-06.md"],
      [
        "地狱焚决群增量总结-20260916-0922.md",
        "地狱焚决群增量总结-20260916-0922.md",
      ],
      ["result.md", "/tmp/project/result.md"],
    ],
  );
});
