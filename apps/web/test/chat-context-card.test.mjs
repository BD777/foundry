import assert from "node:assert/strict";
import test from "node:test";
import {
  sessionEventLabels,
  subagentResponseFingerprint,
} from "@bd777/foundry-protocol";
import { chatContextCardForSessions } from "../src/features/chat/context/chat-context-model.ts";
import { shouldDisplayResponseEvent } from "../src/features/chat/thread/subagent-response-filter.ts";
import { panel } from "./fixtures/session-panel.mjs";

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

/** A subagent as the server's panel lists it. */
function subagent(id, detail, taskId, status = "running") {
  return { id, taskId, toolUseId: `tool_${taskId}`, detail, status };
}

const workspaceSource = { id: "evt_workspace", target: "/tmp/project" };

function session(events, status = "running", sessionPanel) {
  return {
    agentId: "agent_test",
    createdLabel: "just now",
    deviceId: "dev_test",
    events,
    ...(sessionPanel ? { panel: sessionPanel } : {}),
    id: "sess_test",
    prompt: "hello",
    provider: "claude",
    status,
    title: "hello",
    updatedLabel: status,
    workspaceId: "ws_test",
  };
}

test("projects subagents and workspace source into the sidecar", () => {
  const data = chatContextCardForSessions([
    session(
      [],
      "running",
      panel({
        focus: true,
        sources: [workspaceSource],
        subagents: [
          subagent("evt_start_1", "Fetch messages", "task_1", "completed"),
          subagent("evt_start_2", "Summarize messages\nin detail", "task_2"),
        ],
      }),
    ),
  ]);

  assert.deepEqual(data?.previews, []);
  assert.deepEqual([...data.changes, ...data.files], []);
  assert.deepEqual(
    data?.subagents.map((item) => [item.id, item.label, item.status]),
    [
      ["evt_start_1", "Fetch messages", "completed"],
      // The label is the detail's first line.
      ["evt_start_2", "Summarize messages", "running"],
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

test("merges subagent status monotonically using raw transcript state", () => {
  const item = session(
    [],
    "running",
    panel({
      focus: true,
      subagents: [subagent("evt_start", "Analyze repository", "task_1")],
    }),
  );
  const usage = { totalTokens: 1200, toolUses: 3, durationMs: 4000 };
  const completed = chatContextCardForSessions([item], {
    [item.id]: [
      {
        responseFingerprints: [subagentResponseFingerprint("Done")],
        sessionId: item.id,
        status: "completed",
        taskId: "task_1",
        title: "Analyze repository",
        toolUseId: "tool_task_1",
        usage,
      },
    ],
  });
  // The discovery's status and usage win; the panel's row keeps its id.
  assert.deepEqual(
    completed?.subagents.map(({ id, status, usage }) => [id, status, usage]),
    [["evt_start", "completed", usage]],
  );

  item.panel = panel({
    focus: true,
    subagents: [
      subagent("evt_start", "Analyze repository", "task_1", "completed"),
    ],
  });
  const staleDiscovery = chatContextCardForSessions([item], {
    [item.id]: [
      {
        responseFingerprints: [],
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
    [],
    "completed",
    panel({
      focus: true,
      subagents: [
        subagent("evt_old_start", "Older task", "task_old", "completed"),
      ],
    }),
  );
  older.id = "sess_old";
  const newer = session(
    [],
    "completed",
    panel({
      focus: true,
      subagents: [subagent("evt_new_start", "Current task", "task_new")],
    }),
  );
  newer.id = "sess_new";
  // A later session with nothing to focus on leaves the focus where it was.
  const quiet = session([], "completed", panel());
  quiet.id = "sess_quiet";

  const data = chatContextCardForSessions([older, newer, quiet]);

  assert.deepEqual(
    data?.subagents.map((item) => [item.label, item.sessionId]),
    [["Current task", "sess_new"]],
  );
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
        responseFingerprints: [subagentResponseFingerprint("Subagent answer")],
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
  const suppressed = new Set(
    ["Subagent answer", "Parent answer"].map(subagentResponseFingerprint),
  );
  const child = event("evt_child", "Response stream", "  Subagent answer\n");
  assert.equal(
    shouldDisplayResponseEvent(child, child.detail, "evt_parent", suppressed),
    false,
  );
  const parent = event("evt_parent", "Response stream", "Parent answer");
  assert.equal(
    shouldDisplayResponseEvent(parent, parent.detail, "evt_parent", suppressed),
    true,
  );
  const other = event("evt_other", "Response stream", "Subagent answers");
  assert.equal(
    shouldDisplayResponseEvent(other, other.detail, "evt_parent", suppressed),
    true,
  );
  const blank = event("evt_blank", "Response stream", " \n");
  assert.equal(
    shouldDisplayResponseEvent(blank, blank.detail, "evt_blank", new Set()),
    false,
  );
});

test("projects the panel's preview urls as web resources", () => {
  const item = session(
    [],
    "running",
    panel({
      focus: true,
      sources: [workspaceSource],
      previews: [
        { id: "evt_output", target: "http://127.0.0.1:4173/dashboard" },
        { id: "evt_root", target: "http://localhost:5173/" },
      ],
    }),
  );

  const data = chatContextCardForSessions([item]);

  assert.deepEqual(
    data?.previews.map(({ id, kind, label, target }) => [
      id,
      kind,
      label,
      target,
    ]),
    [
      [
        "evt_output",
        "web",
        "127.0.0.1:4173/dashboard",
        "http://127.0.0.1:4173/dashboard",
      ],
      ["evt_root", "web", "localhost:5173", "http://localhost:5173/"],
    ],
  );
});

function recorded(id, file) {
  return event(id, "Recorded file", file.workspacePath ?? file.path, "info", {
    sessionFile: file,
  });
}

test("lists the chat's files in Changes and Files, as its panel merges them", () => {
  // The server merged the session's records: plan.md created in one turn
  // and modified in the next is one row across both turns.
  const chat = session(
    [],
    "completed",
    panel({
      sources: [{ id: "evt_workspace", target: "/home/me/repo" }],
      files: [
        // Named by the answer inside the repository, never edited: a file
        // to open, not a change.
        {
          path: "/home/me/repo/README.md",
          workspacePath: "README.md",
          origin: "reference",
          op: "referenced",
          inGitRepo: true,
          turnIds: ["in_2"],
        },
        {
          path: "/home/me/repo/docs/plan.md",
          workspacePath: "docs/plan.md",
          origin: "tool",
          op: "created",
          inGitRepo: true,
          turnIds: ["in_1", "in_2"],
          lineChanges: { added: 2, removed: 3 },
          turnLineChanges: { in_2: { added: 2, removed: 3 } },
        },
        {
          path: "/tmp/fdy-groupscan/products/atlas.md",
          origin: "tool",
          op: "created",
          inGitRepo: false,
          turnIds: ["in_1"],
        },
        {
          path: "/tmp/fdy-groupscan/products/rev.md",
          origin: "reference",
          op: "referenced",
          inGitRepo: false,
          turnIds: ["in_2"],
        },
      ],
    }),
  );

  const data = chatContextCardForSessions(
    [chat],
    {},
    {
      id: "ws_test",
      localPath: "/home/me/repo",
      deviceLabel: "Laptop",
    },
  );

  assert.deepEqual(
    data.changes.map(
      ({ path, op, origin, turnIds, sessionId, diffSessionId }) => [
        path,
        op,
        origin,
        turnIds,
        sessionId,
        diffSessionId,
      ],
    ),
    [
      [
        "/home/me/repo/docs/plan.md",
        "created",
        "tool",
        ["in_1", "in_2"],
        "sess_test",
        "sess_test",
      ],
    ],
  );
  assert.deepEqual(data.changes[0].lineChanges, { added: 2, removed: 3 });
  assert.deepEqual(data.changes[0].turnLineChanges, {
    in_2: { added: 2, removed: 3 },
  });
  assert.deepEqual(
    data.files.map(({ label, origin, turnIds, deviceLabel, diffSessionId }) => [
      label,
      origin,
      turnIds,
      deviceLabel,
      diffSessionId,
    ]),
    [
      ["README.md", "reference", ["in_2"], "Laptop", undefined],
      ["atlas.md", "tool", ["in_1"], "Laptop", "sess_test"],
      ["rev.md", "reference", ["in_2"], "Laptop", undefined],
    ],
  );
});

test("each answer carries its turn's file count and verified references", async () => {
  const { chatMessagesForThread } =
    await import("../src/features/chat/thread/chat-model.ts");
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
