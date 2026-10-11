import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);
const { scheduledNote } =
  await import("../src/features/chat/chat-context-model.ts");
const { sessionProjections } =
  await import("../src/app/projections/sessions.ts");
const { mergeLoadedAgentSession } =
  await import("../src/lib/agent-session-events.ts");
const { sessionTranscriptEntries } =
  await import("../src/features/chat/transcript-adapters.ts");
const { i18n } = await import("../src/i18n/index.ts");

// The real case: a fleet inspection every 30 minutes that Claude Code fires
// 9 min 5 s after :28 and :58.
const inspection = {
  id: "9b17c9d2",
  kind: "cron",
  schedule: "28,58 * * * *",
  humanSchedule: "每 30 分钟",
  recurring: true,
  prompt: "巡检 20 台容器",
};

function session(overrides = {}) {
  return {
    agentId: "agent_test",
    createdLabel: "just now",
    deviceId: "dev_test",
    id: "sess_test",
    prompt: "inspect",
    provider: "claude",
    status: "completed",
    title: "inspect",
    updatedLabel: "completed",
    workspaceId: "ws_test",
    ...overrides,
  };
}

function snapshotEvent(id, tasks) {
  return {
    at: "2026-10-11T05:02:03.000Z",
    detail: "",
    id,
    label: "Scheduled tasks updated",
    level: "info",
    metadata: { timerSnapshot: tasks },
    sessionId: "sess_test",
  };
}

test("an idle chat whose agent holds a timer says when it wakes next", async () => {
  await i18n.changeLanguage("en");
  const schedule = {
    reportedAt: "2026-10-11T05:02:03.000Z",
    timers: [
      {
        id: "9b17c9d2",
        kind: "cron",
        schedule: "28,58 * * * *",
        recurring: true,
      },
    ],
  };
  // Claude Code fires the :58 time at 07:07:05, not at :58.
  assert.equal(
    scheduledNote(schedule, new Date(2026, 9, 11, 7, 0)),
    "1 scheduled task · next at 07:07",
  );
  assert.equal(
    scheduledNote(schedule, new Date(2026, 9, 11, 7, 10)),
    "1 scheduled task · next at 07:37",
  );
  await i18n.changeLanguage("zh-CN");
  assert.equal(
    scheduledNote(schedule, new Date(2026, 9, 11, 7, 10)),
    "1 个定时任务 · 下次 07:37",
  );
  await i18n.changeLanguage("en");
});

test("a pushed timer snapshot sets the session's schedule until the server's session replaces it", () => {
  const data = {
    workspace: { id: "ws_test" },
    agentSessions: [session()],
  };
  const scheduled = sessionProjections.agent_session_event.apply(data, [
    snapshotEvent("evt_1", [inspection]),
  ]);
  const [withTimer] = scheduled.agentSessions;
  assert.equal(withTimer.status, "completed", "the input's status stays");
  assert.deepEqual(
    withTimer.scheduled.timers.map((timer) => timer.id),
    ["9b17c9d2"],
  );
  assert.equal(withTimer.scheduled.timers[0].prompt, undefined);

  const cleared = sessionProjections.agent_session_event.apply(scheduled, [
    snapshotEvent("evt_2", []),
  ]);
  assert.equal(cleared.agentSessions[0].scheduled, undefined);

  // The server's session (here without timers) is the authority.
  const loaded = { ...withTimer, events: [] };
  assert.equal(mergeLoadedAgentSession(loaded, session()).scheduled, undefined);
});

test("a timer's prompt the device sent to resume the session shows as the timer firing, with its time", async () => {
  await i18n.changeLanguage("en");
  const input = {
    at: "2026-10-11T07:55:07.304Z",
    detail: "",
    id: "evt_6060ba9a-2493-4369-48b9-8ae251f61d14",
    label: "User message",
    level: "info",
    sessionId: "sess_test",
    message: {
      id: "6060ba9a-2493-4369-48b9-8ae251f61d14",
      at: "2026-10-11T07:55:07.304Z",
      kind: "user",
      text: "TIMER-PING",
    },
    metadata: {
      timerFire: {
        id: "ab93258a",
        origin: "scheduled",
        prompt: "TIMER-PING",
        startedAt: "2026-10-11T07:55:07.304Z",
        completedAt: "",
      },
    },
  };
  const entries = sessionTranscriptEntries(session({ events: [input] }));
  assert.equal(
    entries.some((entry) => entry.kind === "user"),
    false,
    "no bubble as if the person had typed it",
  );
  const divider = entries.find((entry) => entry.kind === "boundary");
  assert.match(divider.text, /^⏰ Scheduled task fired · /);
});

test("the card's timers are active only while the server's schedule holds them", async () => {
  await i18n.changeLanguage("en");
  const { chatContextCardForSessions } =
    await import("../src/features/chat/chat-context-model.ts");
  const events = [snapshotEvent("evt_1", [inspection])];
  // The real failure: the snapshot says a timer exists, yet the server's
  // session holds none (no process and no device keeps it).
  const stale = chatContextCardForSessions([session({ events })]);
  assert.equal(stale.timers.length, 1);
  assert.equal(stale.timers[0].scheduled, undefined, "not active");

  const scheduled = {
    reportedAt: "2026-10-11T05:02:03.000Z",
    timers: [
      {
        id: "9b17c9d2",
        kind: "cron",
        schedule: "28,58 * * * *",
        recurring: true,
        firstSeenAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ],
  };
  const held = chatContextCardForSessions([session({ events, scheduled })]);
  assert.equal(held.timers[0].scheduled.id, "9b17c9d2");

  // A week after it was first seen, Claude Code deleted it.
  const expired = chatContextCardForSessions([
    session({
      events,
      scheduled: {
        ...scheduled,
        timers: [
          { ...scheduled.timers[0], firstSeenAt: "2026-01-01T00:00:00Z" },
        ],
      },
    }),
  ]);
  assert.equal(expired.timers[0].scheduled, undefined);
});

test("a pushed snapshot keeps when each timer was first seen", () => {
  const data = {
    workspace: { id: "ws_test" },
    agentSessions: [
      session({
        scheduled: {
          reportedAt: "2026-10-10T06:27:13.000Z",
          timers: [
            {
              id: "9b17c9d2",
              kind: "cron",
              schedule: "28,58 * * * *",
              recurring: true,
              firstSeenAt: "2026-10-10T06:27:13.000Z",
            },
          ],
        },
      }),
    ],
  };
  const next = sessionProjections.agent_session_event.apply(data, [
    snapshotEvent("evt_2", [inspection, { ...inspection, id: "other" }]),
  ]);
  assert.deepEqual(
    next.agentSessions[0].scheduled.timers.map((timer) => timer.firstSeenAt),
    ["2026-10-10T06:27:13.000Z", "2026-10-11T05:02:03.000Z"],
  );
});
