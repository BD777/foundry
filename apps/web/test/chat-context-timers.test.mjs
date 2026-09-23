import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);
const { chatContextCardForSessions } =
  await import("../src/features/chat/chat-context-model.ts");
const { sessionTranscriptEntries } =
  await import("../src/features/chat/transcript-adapters.ts");
const { shouldDisplayAgentSessionEvent } =
  await import("../src/lib/agent-session-events.ts");

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

function session(events, status = "completed") {
  return {
    agentId: "agent_test",
    createdLabel: "just now",
    deviceId: "dev_test",
    events,
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

test("projects the latest timer snapshot into the sidecar", () => {
  const data = chatContextCardForSessions([
    session([
      snapshotEvent,
      event("evt_snapshot_2", "定时任务更新", "", { timerSnapshot: [] }),
    ]),
  ]);
  // Empty later snapshot means the agent deleted the timer, so the card has
  // nothing left to show.
  assert.equal(data, undefined);

  const live = chatContextCardForSessions([session([snapshotEvent])]);
  assert.equal(live?.timers.length, 1);
  const timer = live?.timers[0];
  assert.equal(timer?.task.id, "job_1");
  assert.equal(timer?.task.humanSchedule, "每 10 分钟");
  assert.equal(timer?.fires.length, 0);
});

test("correlates timer fires with the snapshot task", () => {
  const fire = event("evt_fire", "定时任务触发", "跟进群新消息", {
    timerFire: {
      completedAt: "2026-09-20T04:00:34.000Z",
      id: "job_1",
      origin: "scheduled",
      prompt: "跟进群新消息",
      response: "群里暂无新消息",
    },
  });
  const data = chatContextCardForSessions([session([snapshotEvent, fire])]);
  assert.equal(data?.timers[0]?.fires.length, 1);
  assert.equal(data?.timers[0]?.fires[0]?.response, "群里暂无新消息");
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
  assert.match(boundary?.text ?? "", /定时任务触发/);
  const answer = entries.find((entry) => entry.kind === "assistant");
  assert.equal(answer?.text, "群里暂无新消息");
});
