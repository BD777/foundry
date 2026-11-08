import assert from "node:assert/strict";
import test from "node:test";
import { SessionTimers } from "../dist/session/tasks/session-timers.js";
import {
  TimerRevival,
  catchUpPrompt,
  claudeTimerMaxAgeMs,
  planTimerRevival,
} from "../dist/session/tasks/timer-revival.js";

const minute = 60_000;
const start = Date.parse("2026-11-07T10:00:00Z");

// A ScheduleWakeup (dynamic /loop) wakeup, due two minutes after start.
const wakeup = {
  id: "cron_7",
  kind: "wakeup",
  schedule: "2 10 7 11 *",
  humanSchedule: "once",
  recurring: false,
  prompt: "check the build",
  nextFireAt: new Date(start + 2 * minute).toISOString(),
  createdBy: "ScheduleWakeup",
};
// A CronCreate job every 30 minutes; Claude Code brings it back on resume.
const inspection = {
  id: "9b17c9d2",
  kind: "cron",
  schedule: "28,58 * * * *",
  humanSchedule: "every 30 minutes",
  recurring: true,
  prompt: "inspect the containers",
  createdBy: "CronCreate",
};

function plan(overrides) {
  return planTimerRevival({
    task: wakeup,
    held: false,
    orphan: true,
    heldAt: new Date(start - minute).toISOString(),
    startedAt: start,
    now: start,
    ...overrides,
  });
}

test("a wakeup due after the restart waits for its time, then fires once, on time", () => {
  assert.deepEqual(plan({}), {
    action: "wait",
    at: start + 2 * minute,
  });
  assert.deepEqual(plan({ now: start + 2 * minute + 500 }), {
    action: "fire",
    dueAt: wakeup.nextFireAt,
    catchUp: false,
  });
});

test("a wakeup due while the worker was down fires once, as a catch-up", () => {
  assert.deepEqual(
    plan({ startedAt: start + 10 * minute, now: start + 10 * minute }),
    { action: "fire", dueAt: wakeup.nextFireAt, catchUp: true },
  );
  // Delivered (or fired by Claude): never again.
  assert.deepEqual(
    plan({
      startedAt: start + 10 * minute,
      now: start + 11 * minute,
      fired: {
        dueAt: wakeup.nextFireAt,
        at: new Date(start + 10 * minute).toISOString(),
      },
    }),
    { action: "done" },
  );
});

test("a cron is Claude's while a process holds the session; a wakeup of an ended process stays the device's", () => {
  assert.deepEqual(
    plan({
      task: inspection,
      held: true,
      orphan: false,
      now: start + 60 * minute,
    }),
    { action: "native" },
  );
  // The live process made this wakeup: it fires it.
  assert.deepEqual(plan({ held: true, orphan: false }), { action: "native" });
  // A new process resumed the session: it does not bring the wakeup back.
  assert.deepEqual(
    plan({ held: true, orphan: true, now: start + 3 * minute }),
    {
      action: "fire",
      dueAt: wakeup.nextFireAt,
      catchUp: false,
    },
  );
});

test("an unheld cron missed many times fires once as a catch-up, then waits for its next time", () => {
  const heldAt = new Date(start - 3 * 60 * minute).toISOString();
  const first = planTimerRevival({
    task: inspection,
    held: false,
    orphan: false,
    heldAt,
    startedAt: start,
    now: start,
  });
  assert.equal(first.action, "fire");
  assert.equal(first.catchUp, true);
  assert.ok(Date.parse(first.dueAt) < start);
  assert.ok(Date.parse(first.dueAt) > Date.parse(heldAt));
  const after = planTimerRevival({
    task: inspection,
    held: false,
    orphan: false,
    heldAt,
    fired: { dueAt: first.dueAt, at: new Date(start).toISOString() },
    startedAt: start,
    now: start + 1000,
  });
  assert.equal(after.action, "wait");
  assert.ok(after.at > start);
});

test("a CronCreate one-time job is due at its schedule's first time after it was made, not a stale snapshot time", () => {
  const due = new Date(start + 5 * minute);
  const once = {
    id: "1a2b3c4d",
    kind: "wakeup",
    // Claude Code's one-time schedule names a minute and hour only.
    schedule: `${due.getMinutes()} ${due.getHours()} * * *`,
    humanSchedule: "once",
    recurring: false,
    prompt: "check the build",
    // A snapshot's reading a day early (claudeTimerNextFire looks back a day).
    nextFireAt: new Date(start - 24 * 60 * minute + 5 * minute).toISOString(),
    createdBy: "CronCreate",
  };
  const decision = planTimerRevival({
    task: once,
    held: false,
    orphan: false,
    heldAt: new Date(start).toISOString(),
    seenAt: new Date(start).toISOString(),
    startedAt: start + minute,
    now: start + minute,
  });
  assert.equal(decision.action, "wait");
  assert.ok(Math.abs(decision.at - due.getTime()) <= minute);
});

test("a timer past Claude Code's age limit is not caught up", () => {
  const old = start - claudeTimerMaxAgeMs - minute;
  assert.deepEqual(
    planTimerRevival({
      task: inspection,
      held: false,
      orphan: false,
      heldAt: new Date(old).toISOString(),
      seenAt: new Date(old).toISOString(),
      startedAt: start,
      now: start,
    }),
    { action: "done" },
  );
  assert.deepEqual(
    plan({
      task: { ...wakeup, nextFireAt: new Date(old).toISOString() },
      heldAt: new Date(old - minute).toISOString(),
    }),
    { action: "done" },
  );
});

function revival({ now, held = false, kept, answers = [] }) {
  let clock = now;
  const timers = new SessionTimers(undefined, () => clock);
  for (const [sessionId, tasks, heldAt] of kept) {
    clock = heldAt;
    timers.record(sessionId, `native_${sessionId}`, tasks);
  }
  clock = now;
  if (held) timers.attach("sess_1", "native_sess_1", { name: "process" });
  const calls = [];
  const deliveries = new TimerRevival(
    timers,
    async (sessionId, fire) => {
      calls.push({ sessionId, ...fire });
      return answers.shift() ?? "delivered";
    },
    () => clock,
    () => {},
  );
  return {
    timers,
    calls,
    deliveries,
    tick: (ms) => {
      clock += ms;
    },
  };
}

test("a kept wakeup is delivered once, however often the device sweeps", async () => {
  const run = revival({
    now: start + 10 * minute,
    kept: [["sess_1", [wakeup], start - minute]],
  });
  await run.deliveries.sweep();
  await run.deliveries.sweep();
  assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0].timerId, "cron_7");
  assert.equal(run.calls[0].dueAt, wakeup.nextFireAt);
  assert.equal(run.calls[0].catchUp, true);
  assert.equal(
    run.calls[0].prompt,
    catchUpPrompt("check the build", wakeup.nextFireAt),
  );
  assert.deepEqual(
    run.timers.kept(),
    [],
    "a one-time timer is done once delivered",
  );
});

test("a busy session gets the same due time again later", async () => {
  const run = revival({
    now: start + minute,
    kept: [["sess_1", [wakeup], start - minute]],
    answers: ["busy"],
  });
  await run.deliveries.sweep();
  assert.equal(run.calls.length, 0, "not due yet");
  run.tick(70_000);
  await run.deliveries.sweep();
  await run.deliveries.sweep();
  assert.equal(
    run.calls.length,
    1,
    "refused just now: not asked again at once",
  );
  run.tick(31_000);
  await run.deliveries.sweep();
  assert.equal(run.calls.length, 2);
  assert.equal(run.calls[1].dueAt, run.calls[0].dueAt);
  assert.equal(run.calls[1].catchUp, false);
  assert.equal(run.calls[1].prompt, "check the build");
});

test("a session a process holds again keeps its cron with Claude and gets the old process's wakeup", async () => {
  const run = revival({
    now: start + 3 * minute,
    held: true,
    kept: [["sess_1", [wakeup, inspection], start - minute]],
  });
  // The new process is handed the cron only.
  assert.deepEqual(
    run.timers.kept()[0].timers.map((task) => task.id),
    ["9b17c9d2"],
  );
  await run.deliveries.sweep();
  assert.deepEqual(
    run.calls.map((call) => call.timerId),
    ["cron_7"],
  );
  // The live process reports its timers: the delivered wakeup stays done.
  run.timers.record("sess_1", "native_sess_1", [inspection]);
  run.tick(60 * minute);
  await run.deliveries.sweep();
  assert.equal(run.calls.length, 1, "the cron is never delivered while held");
});

test("a gone session's timers are dropped", async () => {
  const run = revival({
    now: start + 3 * minute,
    kept: [["sess_1", [wakeup], start - minute]],
    answers: ["gone"],
  });
  await run.deliveries.sweep();
  assert.deepEqual(run.timers.kept(), []);
});
