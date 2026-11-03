import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { panel } from "./fixtures/session-panel.mjs";

register("./bundler-resolve.mjs", import.meta.url);
const { chatContextCardForSessions } =
  await import("../src/features/chat/context/chat-context-model.ts");
const { sessionTranscriptEntries } =
  await import("../src/features/chat/thread/transcript-adapters.ts");
const { shouldDisplayAgentSessionEvent } =
  await import("../src/lib/agent-session-events.ts");
const { i18n } = await import("../src/i18n/index.ts");

/** The sections a card shows below the session's status line. */
const panelSections = (card) =>
  Object.entries(card ?? {})
    .filter(([key, value]) => key !== "status" && value.length > 0)
    .map(([key]) => key);

function event(id, label, detail, metadata) {
  return {
    at: "2026-09-20T03:52:49.000Z",
    detail,
    id,
    label,
    level: "info",
    metadata,
    sessionId: "sess_test",
  };
}

function session(events, status = "completed", sessionPanel) {
  return {
    agentId: "agent_test",
    createdLabel: "just now",
    deviceId: "dev_test",
    events,
    ...(sessionPanel ? { panel: sessionPanel } : {}),
    id: "sess_test",
    prompt: "跟进群消息",
    provider: "claude",
    status,
    title: "跟进群消息",
    updatedLabel: status,
    workspaceId: "ws_test",
  };
}

const snapshotEvent = event("evt_snapshot", "定时任务更新", "每 10 分钟", {
  timerSnapshot: [
    {
      humanSchedule: "每 10 分钟",
      id: "job_1",
      kind: "cron",
      nextFireAt: "2026-09-20T04:04:00.000Z",
      prompt: "跟进群新消息",
      recurring: true,
      schedule: "4,14,24,34,44,54 * * * *",
    },
  ],
});

/** A session whose panel holds `tasks` from a snapshot taken `at`. */
function timerSession(tasks, at = snapshotEvent.at, runs = []) {
  return session(
    [],
    "completed",
    panel({
      focus: tasks.length > 0,
      timers: tasks.map((task) => ({
        task,
        runs: runs.filter((run) => run.id === task.id),
      })),
      timerSnapshotAt: at,
    }),
  );
}
const job = snapshotEvent.metadata.timerSnapshot[0];

test("projects the panel's timers and their runs into the sidecar", () => {
  // No timers left: the card has nothing to show but the status line.
  assert.deepEqual(
    panelSections(chatContextCardForSessions([timerSession([])])),
    [],
  );

  const run = {
    completedAt: "2026-09-20T04:00:34.000Z",
    id: "job_1",
    origin: "scheduled",
    prompt: "跟进群新消息",
    response: "群里暂无新消息",
  };
  const live = chatContextCardForSessions([
    timerSession([job], snapshotEvent.at, [run]),
  ]);
  assert.equal(live?.timers.length, 1);
  const timer = live?.timers[0];
  assert.equal(timer?.id, "sess_test:timer:job_1");
  assert.equal(timer?.task.id, "job_1");
  assert.equal(timer?.task.humanSchedule, "每 10 分钟");
  assert.equal(timer?.detail, "跟进群新消息");
  assert.deepEqual(timer?.fires, [run]);
});

test("the timer label follows the viewer's language, even for a Chinese-recorded snapshot", async () => {
  const previous = i18n.language;
  try {
    await i18n.changeLanguage("en");
    const english = chatContextCardForSessions([timerSession([job])])
      ?.timers[0];
    assert.equal(english?.label, "Every 10 minutes");

    const untitled = {
      humanSchedule: "每天 09:00",
      id: "job_2",
      kind: "cron",
      prompt: "",
      recurring: true,
      schedule: "0 9 * * *",
    };
    const fallback = chatContextCardForSessions([timerSession([untitled])])
      ?.timers[0];
    assert.equal(fallback?.label, "Daily 09:00");
    assert.equal(fallback?.detail, "Daily 09:00");

    await i18n.changeLanguage("zh-CN");
    const chinese = chatContextCardForSessions([timerSession([job])])
      ?.timers[0];
    assert.equal(chinese?.label, "每 10 分钟");
    assert.equal(
      chatContextCardForSessions([timerSession([untitled])])?.timers[0]?.detail,
      "每天 09:00",
    );
  } finally {
    await i18n.changeLanguage(previous);
  }
});

test("a one-off timer is dated from its snapshot, in the viewer's language", async () => {
  const previous = i18n.language;
  const at = new Date(2026, 8, 20, 12, 0, 0).toISOString();
  const oneOff = {
    humanSchedule: "单次 · 2026/9/21 09:00:00",
    id: "job_3",
    kind: "wakeup",
    prompt: "提醒开会",
    recurring: false,
    schedule: "0 9 1 * 1",
  };
  try {
    await i18n.changeLanguage("en");
    assert.equal(
      chatContextCardForSessions([timerSession([oneOff], at)])?.timers[0]
        ?.label,
      "Once · 9/21/2026, 09:00:00",
    );
    await i18n.changeLanguage("zh-CN");
    assert.equal(
      chatContextCardForSessions([timerSession([oneOff], at)])?.timers[0]
        ?.label,
      "单次 · 2026/9/21 09:00:00",
    );
  } finally {
    await i18n.changeLanguage(previous);
  }
});

test("timer snapshot events are not rendered in the conversation, but fires are", () => {
  assert.equal(shouldDisplayAgentSessionEvent(snapshotEvent), false);

  const fire = event("evt_fire", "定时任务触发", "跟进群新消息", {
    timerFire: {
      completedAt: "2026-09-20T04:00:34.000Z",
      id: "job_1",
      origin: "scheduled",
      prompt: "跟进群新消息",
      response: "群里暂无新消息",
    },
  });
  const entries = sessionTranscriptEntries(session([snapshotEvent, fire]));
  const kinds = entries.map((entry) => entry.kind);
  assert.ok(!kinds.includes("status"), "snapshot sync must not appear");
  assert.ok(kinds.includes("boundary"));
  const boundary = entries.find((entry) => entry.kind === "boundary");
  assert.match(boundary?.text ?? "", /Scheduled task fired/);
  const answer = entries.find((entry) => entry.kind === "assistant");
  assert.equal(answer?.text, "群里暂无新消息");
});
