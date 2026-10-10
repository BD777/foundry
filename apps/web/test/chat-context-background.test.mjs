import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);
const {
  backgroundWorkNote,
  chatContextCardForSessions,
  runningBackgroundWork,
} = await import("../src/features/chat/chat-context-model.ts");
const { backgroundRowDetail } =
  await import("../src/features/chat/chat-context-card.tsx");
const { sessionTranscriptEntries } =
  await import("../src/features/chat/transcript-adapters.ts");
const { shouldDisplayAgentSessionEvent } =
  await import("../src/lib/agent-session-events.ts");
const { i18n } = await import("../src/i18n/index.ts");

function event(id, label, detail, metadata, level = "info") {
  return {
    at: "2026-10-09T15:20:00.000Z",
    detail,
    id,
    label,
    level,
    metadata,
    sessionId: "sess_bg",
  };
}

function session(events, overrides = {}) {
  return {
    agentId: "agent_test",
    createdLabel: "just now",
    deviceId: "dev_test",
    events,
    id: "sess_bg",
    prompt: "run the suite in the background",
    provider: "claude",
    status: "completed",
    title: "Suite",
    updatedLabel: "completed",
    workspaceId: "ws_test",
    ...overrides,
  };
}

const task = (id, overrides = {}) => ({
  id,
  provider: "claude",
  kind: "command",
  description: `Task ${id}`,
  status: "completed",
  startedAt: "2026-10-09T15:00:00.000Z",
  endedAt: "2026-10-09T15:07:00.000Z",
  exitCode: 0,
  hasOutput: true,
  ...overrides,
});

const snapshot = (id, tasks) =>
  event(id, "Background tasks updated", "", { backgroundTaskSnapshot: tasks });

test("the Background section lists commands, monitors and workflows, running first", async () => {
  await i18n.changeLanguage("en");
  const data = chatContextCardForSessions([
    session([
      snapshot("evt_old", [
        task("bold", { status: "running", endedAt: undefined }),
      ]),
      snapshot("evt_latest", [
        task("bdone", { endedAt: "2026-10-09T15:07:00.000Z" }),
        task("bsleep", {
          description: "Sleep 12 minutes",
          endedAt: undefined,
          exitCode: undefined,
          startedAt: "2026-10-09T15:10:00.000Z",
          status: "running",
        }),
        task("bfail", {
          endedAt: "2026-10-09T15:09:00.000Z",
          exitCode: 144,
          status: "failed",
        }),
        task("a4c35", {
          kind: "subagent",
          description: "Audit auth",
          status: "running",
          endedAt: undefined,
        }),
        task("bsub", {
          kind: "monitor",
          ownerSubagentTaskId: "a4c35",
          status: "stopped",
          stopReason: "user",
          exitCode: undefined,
        }),
      ]),
    ]),
  ]);
  assert.deepEqual(
    data.background.map((item) => [item.task.id, item.task.status]),
    [
      ["bsleep", "running"],
      ["bfail", "failed"],
      ["bdone", "completed"],
      ["bsub", "stopped"],
    ],
  );
  const byId = new Map(data.background.map((item) => [item.task.id, item]));
  const now = Date.parse("2026-10-09T15:33:00.000Z");
  assert.equal(
    backgroundRowDetail(byId.get("bsleep"), now),
    "Command · running 23m 0s",
  );
  assert.equal(
    backgroundRowDetail(byId.get("bdone"), now),
    "Command · done in 7m 0s · exit 0",
  );
  assert.equal(
    backgroundRowDetail(byId.get("bfail"), now),
    "Command · failed · exit 144",
  );
  assert.equal(
    backgroundRowDetail(byId.get("bsub"), now),
    "Monitor · from Audit auth · stopped",
  );
  assert.equal(
    data.subagents.length,
    0,
    "background subagents come from subagent events, not this list",
  );
});

const subagentStart = (id, taskId, description) =>
  event(id, "Starting subtask", description, {
    taskId,
    taskType: "local_agent",
    toolUseId: `toolu_${taskId}`,
  });

test("an idle chat's note counts running tasks and running subagents", async () => {
  await i18n.changeLanguage("en");
  const card = (events) => chatContextCardForSessions([session(events)]);
  const commands = snapshot("evt_bg", [
    task("bsleep", { status: "running", endedAt: undefined }),
    task("bwatch", { kind: "monitor", status: "running", endedAt: undefined }),
    // The snapshot's own subagent row is the Subagents section's to count.
    task("a4c35", { kind: "subagent", status: "running", endedAt: undefined }),
    task("bdone"),
  ]);
  const audit = subagentStart("evt_sub1", "a4c35", "Audit auth");
  const review = subagentStart("evt_sub2", "a9f01", "Review styles");
  const reviewDone = event("evt_sub2_done", "Subtask completed", "", {
    taskId: "a9f01",
    toolUseId: "toolu_a9f01",
  });

  const subagentOnly = runningBackgroundWork(card([audit, review, reviewDone]));
  assert.deepEqual(subagentOnly, {
    taskIds: [],
    subagentIds: ["evt_sub1"],
  });
  assert.equal(
    backgroundWorkNote(subagentOnly),
    "1 subagent running in the background",
  );

  const mixed = runningBackgroundWork(card([commands, audit, review]));
  assert.deepEqual(mixed, {
    taskIds: ["sess_bg:background:bsleep", "sess_bg:background:bwatch"],
    subagentIds: ["evt_sub1", "evt_sub2"],
  });
  assert.equal(
    backgroundWorkNote(mixed),
    "2 tasks and 2 subagents running in the background",
  );
  assert.equal(
    backgroundWorkNote({ taskIds: ["t1"], subagentIds: [] }),
    "1 task running in the background",
  );
  assert.equal(
    backgroundWorkNote({ taskIds: ["t1", "t2"], subagentIds: ["s1"] }),
    "2 tasks and 1 subagent running in the background",
  );

  await i18n.changeLanguage("zh-CN");
  assert.equal(
    backgroundWorkNote({ taskIds: [], subagentIds: ["s1"] }),
    "1 个子智能体在后台运行",
  );
  assert.equal(
    backgroundWorkNote({ taskIds: ["t1", "t2"], subagentIds: ["s1"] }),
    "2 个任务、1 个子智能体在后台运行",
  );
  await i18n.changeLanguage("en");

  // Nothing running, or no side panel at all: no note.
  const idle = runningBackgroundWork(
    card([snapshot("evt_1", [task("bdone")]), review, reviewDone]),
  );
  assert.deepEqual(idle, { taskIds: [], subagentIds: [] });
  assert.equal(backgroundWorkNote(idle), "");
  assert.deepEqual(runningBackgroundWork(undefined), {
    taskIds: [],
    subagentIds: [],
  });
  // Codex reports no background work: nothing to show.
  assert.equal(
    chatContextCardForSessions([
      session([snapshot("evt_1", [task("bx", { status: "running" })])], {
        provider: "codex",
      }),
    ])?.background.length ?? 0,
    0,
  );
});

test("background snapshots stay out of the transcript; Claude's follow-up gets its own divider", async () => {
  await i18n.changeLanguage("en");
  const sync = snapshot("evt_sync", [task("bsleep", { status: "running" })]);
  assert.equal(shouldDisplayAgentSessionEvent(sync), false);
  const followUp = event(
    "evt_follow",
    "Background task continued",
    'Background command "Sleep 12 minutes" completed (exit code 0)',
    {
      timerFire: {
        origin: "background",
        prompt: 'Background command "Sleep 12 minutes" completed (exit code 0)',
        response: "The sleep finished: done.",
        completedAt: "2026-10-09T15:27:00.000Z",
      },
      turnUsage: {
        durationMs: 2000,
        inputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 5,
      },
      fileReferences: [
        { text: "notes.txt", path: "/work/notes.txt", kind: "file" },
      ],
    },
  );
  const entries = sessionTranscriptEntries(session([sync, followUp]));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, "boundary");
  assert.match(entries[0].text, /^Claude continued after background work · /);
  assert.equal(entries[1].kind, "assistant");
  assert.equal(entries[1].text, "The sleep finished: done.");
  assert.equal(entries[1].usage.outputTokens, 5);
  assert.deepEqual(entries[1].fileReferences, [
    { text: "notes.txt", path: "/work/notes.txt", kind: "file" },
  ]);
});
