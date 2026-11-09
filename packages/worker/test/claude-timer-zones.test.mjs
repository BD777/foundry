// The worker and the Claude process it runs may read time in different
// zones: a connection can set the process's TZ. Here, as on the device
// where this was found, the worker runs in Asia/Shanghai and Claude in
// America/Toronto (13 hours apart in November).
process.env.TZ = "Asia/Shanghai";

import assert from "node:assert/strict";
import test from "node:test";
import {
  sessionScheduleFromSnapshot,
  sessionScheduledTimerEnded,
} from "@bd777/foundry-protocol";
import {
  ClaudeTimerTracker,
  claudeTimeZone,
} from "../dist/session/tasks/agent-timers.js";
import { SessionTimers } from "../dist/session/tasks/session-timers.js";
import { planTimerRevival } from "../dist/session/tasks/timer-revival.js";

const toronto = "America/Toronto";
const minute = 60_000;
const torontoClock = (at) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: toronto,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);

function tracker({ known = [], owed = () => [], timeZone = toronto } = {}) {
  const events = [];
  const held = [];
  const timers = new ClaudeTimerTracker(
    {
      emit: (event) => events.push(event),
      isActiveTurn: () => false,
      sessionId: () => "sess_zone",
      timersChanged: (tasks) => held.push(tasks),
      deviceWakeups: owed,
    },
    known,
    timeZone,
  );
  const hooks = timers.hooks();
  return {
    timers,
    events,
    held,
    reported: () => events.at(-1)?.metadata.timerSnapshot,
    postToolUse: (input) => hooks.PostToolUse[0].hooks[0](input),
    stop: (crons) => hooks.Stop[0].hooks[0]({ session_crons: crons }),
  };
}

test("Claude's zone: its settings' TZ, else its process's, else the worker's", () => {
  assert.equal(
    claudeTimeZone({ TZ: "Europe/Paris" }, { TZ: toronto }),
    toronto,
  );
  assert.equal(claudeTimeZone({ TZ: ":America/Toronto" }), toronto);
  assert.equal(claudeTimeZone({ TZ: "Not/AZone" }), "Asia/Shanghai");
  assert.equal(claudeTimeZone(undefined), "Asia/Shanghai");
});

test("a Claude process in another zone: matching, fire time, revival and the ended rule agree", async () => {
  const scheduledAt = Date.parse("2026-11-05T12:25:34Z");
  const scheduledFor = Date.parse("2026-11-05T12:46:00Z");
  const { stop, postToolUse, reported } = tracker();
  await postToolUse({
    tool_name: "ScheduleWakeup",
    tool_input: { delaySeconds: 1234, prompt: "check the build" },
    tool_response: { scheduledFor },
  });
  const [provisional] = reported();
  // 12:46Z is 07:46 in Toronto (20:46 in Shanghai).
  assert.equal(provisional.schedule, "46 7 5 11 *");
  assert.equal(provisional.timeZone, toronto);
  assert.equal(provisional.nextFireAt, "2026-11-05T12:46:00.000Z");

  // Claude lists it under its own id, as its own wall clock reads it.
  await stop([
    {
      id: "14db6a22",
      prompt: "check the build",
      recurring: false,
      schedule: "46 7 * * *",
    },
  ]);
  const [wakeup] = reported();
  assert.equal(wakeup.id, "14db6a22");
  assert.equal(wakeup.createdBy, "ScheduleWakeup", "matched to its call");
  assert.equal(
    wakeup.nextFireAt,
    "2026-11-05T12:46:00.000Z",
    "keeps the time Claude scheduled, not 07:46 Shanghai",
  );
  assert.equal(wakeup.timeZone, toronto);

  // A one-time CronCreate job is read in Claude's zone too: 09:47 there.
  await postToolUse({
    tool_name: "CronCreate",
    tool_input: { cron: "47 9 * * *", prompt: "report", recurring: false },
    tool_response: { id: "0a000000", recurring: false },
  });
  const job = reported().find((task) => task.id === "0a000000");
  const jobFire = Date.parse(job.nextFireAt);
  assert.equal(torontoClock(jobFire), "09:47");
  // A recurring one names its zone where it is not the reader's.
  await postToolUse({
    tool_name: "CronCreate",
    tool_input: { cron: "0 9 * * 1-5", prompt: "standup", recurring: true },
    tool_response: { id: "0b000000", recurring: true },
  });
  const standup = reported().find((task) => task.id === "0b000000");
  assert.equal(standup.humanSchedule, "工作日 09:00 (America/Toronto)");

  // The device delivers the wakeup at 12:46Z when no process holds it.
  const plan = (now) =>
    planTimerRevival({
      task: wakeup,
      held: false,
      orphan: true,
      seenAt: new Date(scheduledAt).toISOString(),
      heldAt: new Date(scheduledAt).toISOString(),
      startedAt: scheduledAt - minute,
      now,
    });
  assert.deepEqual(plan(scheduledFor - 5 * minute), {
    action: "wait",
    at: scheduledFor,
  });
  assert.deepEqual(plan(scheduledFor + minute), {
    action: "fire",
    dueAt: "2026-11-05T12:46:00.000Z",
    catchUp: false,
  });
  // Revival reads the job's schedule in Claude's zone as well.
  const cron = planTimerRevival({
    task: job,
    held: false,
    orphan: false,
    seenAt: new Date(jobFire - 10 * minute).toISOString(),
    heldAt: new Date(jobFire - 10 * minute).toISOString(),
    startedAt: jobFire - 20 * minute,
    now: jobFire - 5 * minute,
  });
  assert.deepEqual(cron, { action: "wait", at: jobFire });

  // The session's schedule shows the wakeup until an hour after it fired.
  const schedule = sessionScheduleFromSnapshot(
    reported(),
    new Date(scheduledAt).toISOString(),
  );
  const held = schedule.timers.find((timer) => timer.id === "14db6a22");
  assert.equal(held.timeZone, toronto);
  assert.equal(
    sessionScheduledTimerEnded(held, new Date(scheduledFor + 30 * minute)),
    false,
  );
  assert.equal(
    sessionScheduledTimerEnded(held, new Date(scheduledFor + 61 * minute)),
    true,
  );
});

test("a timer recorded before zones keeps showing for two days past its time, then ends", () => {
  // The record that left the clock on: Shanghai's reading of Toronto's
  // 07:46, 13 hours before the snapshot itself.
  const legacy = {
    id: "14db6a22",
    kind: "wakeup",
    schedule: "46 7 * * *",
    recurring: false,
    nextFireAt: "2026-11-04T23:46:00.000Z",
    firstSeenAt: "2026-11-05T12:25:34.266657679Z",
  };
  assert.equal(
    sessionScheduledTimerEnded(legacy, new Date("2026-11-06T12:00:00Z")),
    false,
  );
  assert.equal(
    sessionScheduledTimerEnded(legacy, new Date("2026-11-09T03:30:00Z")),
    true,
  );
  const recurring = { ...legacy, recurring: true, kind: "cron" };
  assert.equal(
    sessionScheduledTimerEnded(recurring, new Date("2026-11-09T03:30:00Z")),
    false,
    "a recurring timer lives a week",
  );
});

test("after a restart, the first list keeps a wakeup the device still delivers and clears what is gone", async () => {
  const wakeup = {
    id: "14db6a22",
    kind: "wakeup",
    schedule: "46 7 * * *",
    humanSchedule: "单次",
    recurring: false,
    prompt: "check the build",
    nextFireAt: "2026-11-05T12:46:00.000Z",
    createdBy: "ScheduleWakeup",
    timeZone: toronto,
  };
  const kept = new SessionTimers();
  // Process 1 holds the wakeup, then ends.
  const first = { name: "process 1" };
  kept.attach("sess_zone", "native_1", first);
  kept.record("sess_zone", "native_1", [wakeup]);
  kept.detach("sess_zone", "native_1", [wakeup], first);

  // Process 2 resumes the session: Claude does not bring a wakeup back, so
  // the device delivers it, and the session still waits on it.
  const second = { name: "process 2" };
  const known = kept.attach("sess_zone", "native_1", second);
  assert.deepEqual(known, []);
  const resumed = tracker({
    known,
    owed: () => kept.owedWakeups("sess_zone"),
  });
  await resumed.stop([]);
  assert.deepEqual(
    resumed.reported().map((task) => task.id),
    ["14db6a22"],
    "the revived wakeup survives the first list",
  );
  assert.deepEqual(resumed.held.at(-1), [], "Claude itself holds none");
  assert.deepEqual(
    kept.owedWakeups("sess_zone").map((task) => task.id),
    ["14db6a22"],
  );

  // Delivered: the next list no longer has it.
  kept.markFired("sess_zone", wakeup, wakeup.nextFireAt);
  await resumed.stop([]);
  assert.deepEqual(resumed.reported(), []);

  // A restart with nothing kept clears what an earlier process reported.
  const fresh = tracker();
  await fresh.stop([]);
  assert.deepEqual(
    fresh.events.map((event) => event.metadata.timerSnapshot),
    [[]],
  );
});
