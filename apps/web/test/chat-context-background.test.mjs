import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);
const { chatContextCardForSessions, runningBackgroundWork } =
  await import("../src/features/chat/chat-context-model.ts");
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

test("an idle chat whose agent keeps working says how much is still running", () => {
  const running = [
    session([
      snapshot("evt_1", [
        task("bsleep", { status: "running", endedAt: undefined }),
        task("a4c35", {
          kind: "subagent",
          status: "running",
          endedAt: undefined,
        }),
        task("bdone"),
      ]),
    ]),
  ];
  assert.equal(runningBackgroundWork(running), 2);
  assert.equal(
    runningBackgroundWork([session([snapshot("evt_1", [task("bdone")])])]),
    0,
  );
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
    },
  );
  const entries = sessionTranscriptEntries(session([sync, followUp]));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, "boundary");
  assert.match(entries[0].text, /^Claude continued after background work · /);
  assert.equal(entries[1].kind, "assistant");
  assert.equal(entries[1].text, "The sleep finished: done.");
  assert.equal(entries[1].usage.outputTokens, 5);
});
