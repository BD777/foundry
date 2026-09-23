import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ClaudeTimerTracker,
  humanizeCron,
  nextCronFire,
} from "../dist/agent-timers.js";

function makeTracker(sinkProps = {}) {
  const events = [];
  const sink = {
    emit: (event) => events.push(event),
    isActiveTurn: () => false,
    sessionId: () => "sess_test",
    ...sinkProps,
  };
  const tracker = new ClaudeTimerTracker(sink);
  return { events, sink, tracker };
}

test("nextCronFire computes the following matching minute", () => {
  const from = new Date("2026-09-20T12:02:00");
  const next = nextCronFire("4,14,24,34,44,54 * * * *", from);
  assert.equal(next?.getMinutes(), 4);
  assert.equal(next.getHours(), 12);

  const daily = nextCronFire("30 9 * * *", new Date("2026-09-20T10:00:00"));
  assert.equal(daily?.getDate(), 21);
  assert.equal(daily?.getHours(), 9);
  assert.equal(daily?.getMinutes(), 30);

  const weekday = nextCronFire("0 10 * * 1-5", new Date("2026-09-19T10:00:00"));
  // 2026-09-19 is a Saturday; next Monday is the 21st.
  assert.equal(weekday?.getDate(), 21);

  assert.equal(nextCronFire("not a cron", from), undefined);
});

test("humanizeCron renders common schedules in Chinese", () => {
  const from = new Date("2026-09-20T12:00:00");
  assert.equal(
    humanizeCron("4,14,24,34,44,54 * * * *", true, from),
    "每 10 分钟",
  );
  assert.equal(humanizeCron("*/15 * * * *", true, from), "每 15 分钟");
  assert.match(humanizeCron("0 9 * * *", true, from), /^每天 09:00$/);
  assert.match(humanizeCron("30 18 * * 1-5", true, from), /^工作日 18:30$/);
  assert.match(humanizeCron("0 10 * * 0,6", true, from), /^周日、周六 10:00$/);
  assert.match(humanizeCron("0 9 1 * *", true, from), /^每月 1 日 09:00$/);
});

test("PostToolUse CronCreate publishes a snapshot and CronDelete clears it", async () => {
  const { events, tracker: timerTracker } = makeTracker();
  await timerTracker.hooks().PostToolUse[0].hooks[0]({
    tool_name: "CronCreate",
    tool_input: { cron: "*/5 * * * *", prompt: "ping", recurring: true },
    tool_response: { id: "job_1", recurring: true },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].metadata.timerSnapshot[0].id, "job_1");
  assert.equal(events[0].metadata.timerSnapshot[0].humanSchedule, "每 5 分钟");

  await timerTracker.hooks().PostToolUse[0].hooks[0]({
    tool_name: "CronDelete",
    tool_input: { id: "job_1" },
  });
  assert.equal(events.length, 2);
  assert.deepEqual(events[1].metadata.timerSnapshot, []);
});

test("subagent timer tool calls are ignored", async () => {
  const { events, tracker: timerTracker } = makeTracker();
  await timerTracker.hooks().PostToolUse[0].hooks[0]({
    agent_id: "subagent-1",
    tool_name: "CronCreate",
    tool_input: { cron: "* * * * *", prompt: "x" },
    tool_response: { id: "job_2" },
  });
  assert.equal(events.length, 0);
});

test("Stop outside an active turn reports a scheduled firing from the transcript", async () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-timers-"));
  const transcriptPath = join(directory, "native.jsonl");
  const promptText = "跟进飞书群新消息";
  const answerText = "群里暂无新消息";
  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({
        type: "user",
        turnOrigin: "scheduled",
        timestamp: "2026-09-20T03:59:37.981Z",
        message: {
          role: "user",
          content: [{ type: "text", text: promptText }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-20T04:00:34.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: answerText }],
        },
      }),
    ].join("\n") + "\n",
  );

  const { events, tracker: timerTracker } = makeTracker({
    isActiveTurn: () => false,
  });
  await timerTracker.hooks().Stop[0].hooks[0]({
    session_crons: [
      {
        id: "job_9",
        prompt: promptText,
        recurring: true,
        schedule: "*/10 * * * *",
      },
    ],
    transcript_path: transcriptPath,
    last_assistant_message: answerText,
  });

  const snapshotEvent = events.find((event) => event.metadata.timerSnapshot);
  assert.ok(snapshotEvent);
  assert.equal(snapshotEvent.metadata.timerSnapshot[0].id, "job_9");

  const fireEvent = events.find((event) => event.metadata.timerFire);
  assert.ok(fireEvent, "a timer fire event should be emitted out of band");
  assert.equal(fireEvent.metadata.timerFire.origin, "scheduled");
  assert.equal(fireEvent.metadata.timerFire.prompt, promptText);
  assert.equal(fireEvent.metadata.timerFire.response, answerText);
  assert.equal(fireEvent.metadata.timerFire.id, "job_9");
  rmSync(directory, { recursive: true, force: true });
});

test("Stop during an active turn only syncs the snapshot, no fire", async () => {
  const { events, tracker: timerTracker } = makeTracker({
    isActiveTurn: () => true,
  });
  await timerTracker.hooks().Stop[0].hooks[0]({
    session_crons: [],
    transcript_path: "/nonexistent/native.jsonl",
  });
  const fires = events.filter((event) => event.metadata.timerFire);
  assert.equal(fires.length, 0);
});
