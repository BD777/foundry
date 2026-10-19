import assert from "node:assert/strict";
import test from "node:test";
import {
  ClaudeTimerTracker,
  humanizeCron,
  nextCronFire,
} from "../dist/agent-timers.js";

function makeTracker(sinkProps = {}, known = []) {
  const events = [];
  const sink = {
    emit: (event) => events.push(event),
    isActiveTurn: () => false,
    sessionId: () => "sess_test",
    ...sinkProps,
  };
  const tracker = new ClaudeTimerTracker(sink, known);
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

test("humanizeCron keeps the rest of its Chinese wording, also when asked for zh-CN", () => {
  const from = new Date("2026-09-20T12:00:00");
  const zh = [
    ["5 * * * *", true, "每小时 05 分"],
    ["0 9,18 * * *", true, "每天 09:00、18:00"],
    ["0 9 1,15 * *", true, "每月 1、15 日 09:00"],
    ["0 9 1 1,7 *", true, "每年 1、7 月 1 日 09:00"],
    ["0 9 1 * 1", false, "单次 · 2026/9/21 09:00:00"],
    ["0 9 1 * 1", true, "定时 0 9 1 * 1"],
    ["not a cron", false, "单次定时 not a cron"],
  ];
  for (const [expression, recurring, expected] of zh) {
    assert.equal(humanizeCron(expression, recurring, from), expected);
    assert.equal(humanizeCron(expression, recurring, from, "zh-CN"), expected);
  }
});

test("humanizeCron renders every recognized shape in English", () => {
  const from = new Date("2026-09-20T12:00:00");
  const en = [
    ["4,14,24,34,44,54 * * * *", true, "Every 10 minutes"],
    ["*/15 * * * *", true, "Every 15 minutes"],
    ["5 * * * *", true, "Hourly at :05"],
    ["0 9 * * *", true, "Daily 09:00"],
    ["0 9,18 * * *", true, "Daily 09:00, 18:00"],
    ["30 18 * * 1-5", true, "Weekdays 18:30"],
    ["0 10 * * 0,6", true, "Sun, Sat 10:00"],
    ["0 9 1 * *", true, "Monthly on day 1, 09:00"],
    ["0 9 1,15 * *", true, "Monthly on day 1, 15, 09:00"],
    ["0 9 1 1,7 *", true, "Yearly in Jan, Jul on day 1, 09:00"],
    ["0 9 1 * 1", false, "Once · 9/21/2026, 09:00:00"],
    ["0 0 1 * 1", false, "Once · 9/21/2026, 00:00:00"],
    ["0 9 1 * 1", true, "Scheduled 0 9 1 * 1"],
    ["not a cron", true, "Scheduled not a cron"],
    ["not a cron", false, "One-time not a cron"],
  ];
  for (const [expression, recurring, expected] of en) {
    const text = humanizeCron(expression, recurring, from, "en");
    assert.equal(text, expected);
    assert.doesNotMatch(text, /[　-鿿]/);
  }
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

test("a prompt Claude submits for a timer starts that timer's turn", async () => {
  const { events, tracker: timerTracker } = makeTracker();
  const hooks = timerTracker.hooks();
  await hooks.PostToolUse[0].hooks[0]({
    tool_name: "CronCreate",
    tool_input: {
      cron: "28,58 * * * *",
      prompt: "巡检 20 台容器",
      recurring: true,
    },
    tool_response: { id: "9b17c9d2", recurring: true, durable: false },
  });
  // Claude Code submits it as a meta prompt of origin "scheduled"; the
  // transcript row is isMeta, the hook still sees it.
  await hooks.UserPromptSubmit[0].hooks[0]({ prompt: "巡检 20 台容器" });
  const fire = timerTracker.takeFire();
  assert.equal(fire.id, "9b17c9d2");
  assert.equal(fire.prompt, "巡检 20 台容器");
  assert.ok(Date.parse(fire.startedAt) > 0);
  assert.equal(timerTracker.takeFire(), undefined, "a fire is taken once");
  // Published as it starts, so readers know it fired and runs; the runner
  // publishes it again with its answer, under the same start time.
  const started = events.filter((event) => event.metadata.timerFire);
  assert.equal(started.length, 1);
  assert.equal(started[0].label, "Scheduled task fired");
  assert.deepEqual(started[0].metadata.timerFire, {
    id: "9b17c9d2",
    origin: "scheduled",
    prompt: "巡检 20 台容器",
    startedAt: fire.startedAt,
    completedAt: "",
  });
});

test("a timer turn published as it started is published as ended when it is dropped or its process ends", async () => {
  const { events, tracker: timerTracker } = makeTracker();
  const submit = timerTracker.hooks().UserPromptSubmit[0].hooks[0];
  const fires = () =>
    events
      .filter((event) => event.metadata?.timerFire)
      .map((event) => event.metadata.timerFire);

  // A Foundry turn took the stream before the timer's turn ended.
  await submit({ prompt: "check the deploy" });
  timerTracker.dropFire();
  assert.equal(fires().length, 2);
  assert.equal(fires()[1].startedAt, fires()[0].startedAt);
  assert.ok(Date.parse(fires()[1].completedAt) > 0);
  assert.equal(fires()[1].response, undefined);

  // The process ended while one ran.
  await submit({ prompt: "check the deploy" });
  timerTracker.close();
  assert.equal(fires().length, 4);
  assert.ok(Date.parse(fires()[3].completedAt) > 0);

  // One a Foundry turn ran was never published, so it has no end either.
  const second = makeTracker({ isActiveTurn: () => true });
  await second.tracker.hooks().PostToolUse[0].hooks[0]({
    tool_name: "CronCreate",
    tool_input: { cron: "28,58 * * * *", prompt: "巡检", recurring: true },
    tool_response: { id: "9b17c9d2", recurring: true },
  });
  await second.tracker.hooks().UserPromptSubmit[0].hooks[0]({ prompt: "巡检" });
  second.tracker.dropFire();
  assert.equal(
    second.events.filter((event) => event.metadata?.timerFire).length,
    0,
  );
});

test("a Foundry turn's prompt or a task notification starts no timer turn", async () => {
  let active = true;
  const { tracker: timerTracker } = makeTracker({ isActiveTurn: () => active });
  const submit = timerTracker.hooks().UserPromptSubmit[0].hooks[0];
  await submit({ prompt: "what changed?" });
  assert.equal(timerTracker.takeFire(), undefined);
  active = false;
  await submit({
    prompt: "<task-notification>\n<task-id>b1</task-id>\n</task-notification>",
  });
  assert.equal(timerTracker.takeFire(), undefined);
  await submit({ agent_id: "sub_1", prompt: "a subagent's prompt" });
  assert.equal(timerTracker.takeFire(), undefined);
  // A prompt Claude submits on its own while no turn runs: a timer's, even
  // one it has not listed yet (a durable task).
  await submit({ prompt: "check the deploy" });
  assert.deepEqual(
    { ...timerTracker.takeFire(), startedAt: undefined },
    {
      announced: true,
      id: undefined,
      prompt: "check the deploy",
      startedAt: undefined,
    },
  );
});

test("a timer whose prompt Claude lists clipped keeps its whole prompt and is recognized", async () => {
  const { events, tracker: timerTracker } = makeTracker();
  const hooks = timerTracker.hooks();
  const prompt = `inspect ${"x".repeat(1200)}`;
  await hooks.PostToolUse[0].hooks[0]({
    tool_name: "CronCreate",
    tool_input: { cron: "*/30 * * * *", prompt, recurring: true },
    tool_response: { id: "c1", recurring: true },
  });
  await hooks.Stop[0].hooks[0]({
    session_crons: [
      {
        id: "c1",
        schedule: "*/30 * * * *",
        recurring: true,
        prompt: `${prompt.slice(0, 1000)}… [+${prompt.length - 1000} chars]`,
      },
    ],
  });
  assert.equal(timerTracker.snapshot()[0].prompt, prompt);
  assert.equal(events.length, 1, "the listed timer is the one already shown");
  await hooks.UserPromptSubmit[0].hooks[0]({ prompt });
  assert.equal(timerTracker.takeFire().id, "c1");
});

test("an ended process's timers are returned, not cleared; a resumed one starts with them", async () => {
  const task = {
    id: "9b17c9d2",
    kind: "cron",
    schedule: "28,58 * * * *",
    humanSchedule: "每 30 分钟",
    recurring: true,
    prompt: "巡检",
  };
  const { events, tracker: timerTracker } = makeTracker();
  await timerTracker.hooks().Stop[0].hooks[0]({
    session_crons: [{ ...task, schedule: task.schedule }],
  });
  assert.equal(events.length, 1);
  assert.deepEqual(
    timerTracker.close().map((entry) => entry.id),
    ["9b17c9d2"],
  );
  assert.equal(events.length, 1, "closing publishes no empty list");

  const resumed = makeTracker({}, [task]);
  assert.deepEqual(resumed.tracker.snapshot(), [task]);
  await resumed.tracker.hooks().Stop[0].hooks[0]({ session_crons: [task] });
  assert.equal(resumed.events.length, 0, "the same timers say nothing new");
  await resumed.tracker.hooks().Stop[0].hooks[0]({ session_crons: [] });
  assert.deepEqual(resumed.events.at(-1).metadata.timerSnapshot, []);
});

test("a snapshot names when Claude Code fires each timer, its offset included", async () => {
  const { events, tracker: timerTracker } = makeTracker();
  await timerTracker.hooks().PostToolUse[0].hooks[0]({
    tool_name: "CronCreate",
    tool_input: { cron: "28,58 * * * *", prompt: "p", recurring: true },
    tool_response: { id: "9b17c9d2", recurring: true },
  });
  const [task] = events[0].metadata.timerSnapshot;
  const next = new Date(task.nextFireAt);
  // 0x9b17c9d2 / 2^32 of half the 30-minute period: 9 min 5 s late.
  assert.equal(next.getSeconds(), 5);
  assert.ok([7, 37].includes(next.getMinutes()), task.nextFireAt);
});

test("Stop during an active turn only syncs the snapshot, no fire", async () => {
  const { events, tracker: timerTracker } = makeTracker({
    isActiveTurn: () => true,
  });
  await timerTracker.hooks().Stop[0].hooks[0]({ session_crons: [] });
  const fires = events.filter((event) => event.metadata.timerFire);
  assert.equal(fires.length, 0);
  assert.equal(timerTracker.takeFire(), undefined);
});

test("a wake-up shows as soon as Claude schedules it, then takes its real id", async () => {
  const { events, tracker: timerTracker } = makeTracker();
  const scheduledFor = Date.parse("2026-10-09T23:40:00");
  await timerTracker.hooks().PostToolUse[0].hooks[0]({
    tool_name: "ScheduleWakeup",
    tool_input: {
      delaySeconds: 600,
      prompt: "check the build",
      reason: "build takes ~10m",
    },
    tool_response: {
      scheduledFor,
      clampedDelaySeconds: 600,
      wasClamped: false,
    },
  });
  const [task] = events.at(-1).metadata.timerSnapshot;
  assert.equal(task.kind, "wakeup");
  assert.equal(task.recurring, false);
  assert.equal(task.schedule, "40 23 9 10 *");
  assert.equal(task.prompt, "check the build");
  assert.match(
    task.humanSchedule,
    /^单次 · /,
    "a wake-up reads as one time, not yearly",
  );

  await timerTracker.hooks().Stop[0].hooks[0]({
    session_crons: [
      {
        id: "cron_7",
        prompt: "check the build",
        recurring: false,
        schedule: "40 23 9 10 *",
      },
    ],
  });
  assert.deepEqual(
    events.at(-1).metadata.timerSnapshot.map((entry) => entry.id),
    ["cron_7"],
  );
});

test("no timer list is published before any timer exists", async () => {
  const { events, tracker: timerTracker } = makeTracker({
    isActiveTurn: () => true,
  });
  await timerTracker.hooks().Stop[0].hooks[0]({ session_crons: [] });
  assert.equal(events.length, 0);
});

test("a timer turn Claude starts on its own waits for what it needs; a Foundry turn's does not", async () => {
  let active = false;
  const started = [];
  const { tracker: timerTracker } = makeTracker({
    isActiveTurn: () => active,
    timerTurnStarting: async () => started.push("refresh"),
  });
  const submit = timerTracker.hooks().UserPromptSubmit[0].hooks[0];
  await submit({ prompt: "check the deploy" });
  assert.deepEqual(started, ["refresh"]);
  active = true;
  await submit({ prompt: "a Foundry turn's prompt" });
  assert.deepEqual(started, ["refresh"], "a dispatch brought its own token");
});

test("authoritative empty Stop inventories are observable without synthetic transcript events", async () => {
  const snapshots = [];
  const tracker = new ClaudeTimerTracker({
    emit: () => {},
    isActiveTurn: () => false,
    sessionId: () => "s",
    timersObserved: (tasks) => snapshots.push(tasks),
  });
  await tracker.hooks().Stop[0].hooks[0]({ session_crons: [] });
  await tracker.hooks().Stop[0].hooks[0]({ session_crons: [] });
  assert.deepEqual(snapshots, [[], []]);
});

test("a version without session_crons never turns a missing inventory into an empty one", async () => {
  const observed = [];
  const known = {
    id: "kept",
    kind: "cron",
    prompt: "inspect",
    schedule: "* * * * *",
    recurring: true,
    humanSchedule: "every minute",
  };
  const tracker = new ClaudeTimerTracker(
    {
      emit: () => {},
      isActiveTurn: () => false,
      sessionId: () => "s",
      timersObserved: (tasks) => observed.push(tasks),
    },
    [known],
  );
  await tracker.hooks().Stop[0].hooks[0]({});
  assert.deepEqual(tracker.snapshot(), [known]);
  assert.deepEqual(observed, []);
});
