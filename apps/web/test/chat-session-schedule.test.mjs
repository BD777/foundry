import assert from "node:assert/strict";
import { register } from "node:module";
import test, { before, after, mock } from "node:test";

register("./bundler-resolve.mjs", import.meta.url);
const { scheduledNote } =
  await import("../src/features/chat/chat-schedule-model.ts");
const { sessionProjections } =
  await import("../src/app/projections/sessions.ts");
const { mergeLoadedAgentSession } =
  await import("../src/lib/agent-session-events.ts");
const { sessionTranscriptEntries } =
  await import("../src/features/chat/transcript-adapters.ts");
const { i18n } = await import("../src/i18n/index.ts");

// Replay the incident at its original time; today's wall clock must not
// expire the recurring timers in this historical fixture.
before(() =>
  mock.timers.enable({ apis: ["Date"], now: new Date(2026, 9, 12, 11, 45) }),
);
after(() => mock.timers.reset());

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

// The real sequence of sess_1791532977920187026 on 2026-10-12 (local
// times; Claude Code reads the cron in the device's): the device sent the
// timer at 10:37:27 to resume the session, which started a Claude process;
// that turn answered at 11:31:04; the process, holding the timer again,
// fired it at 11:30:54 as it went idle and still ran it at 11:45.
const at = (hour, minute, second = 0, ms = 0) =>
  new Date(2026, 9, 12, hour, minute, second, ms).toISOString();

function realEvent(id, iso, label, extra = {}) {
  return {
    at: iso,
    detail: "",
    id,
    label,
    level: "info",
    sessionId: "sess_test",
    ...extra,
  };
}

const realSchedule = {
  reportedAt: "2026-10-11T05:02:03.792Z",
  timers: [
    {
      id: "9b17c9d2",
      kind: "cron",
      schedule: "28,58 * * * *",
      recurring: true,
      nextFireAt: "2026-10-11T04:58:00.000Z",
      firstSeenAt: "2026-10-10T06:27:13.999Z",
    },
  ],
};

function realSession(until, extra = []) {
  const fired = at(10, 37, 27, 296);
  const events = [
    snapshotEvent("evt_snapshot", [inspection]),
    realEvent("evt_input", fired, "User message", {
      message: {
        id: "292ef063-4e86-d843-e044-0adaffa5c082",
        at: fired,
        kind: "user",
        text: "巡检 20 台容器",
      },
      metadata: {
        timerFire: {
          id: "9b17c9d2",
          origin: "scheduled",
          prompt: "巡检 20 台容器",
          startedAt: fired,
          completedAt: "",
        },
      },
    }),
    realEvent("evt_started", at(10, 37, 27, 578), "Started Claude Agent SDK"),
    realEvent("evt_answer", at(11, 31, 3, 677), "Response stream", {
      detail: "目前 20 台容器机队的最新状态",
    }),
    realEvent("evt_finished", at(11, 31, 4, 810), "Claude Agent SDK finished", {
      metadata: {
        turnUsage: {
          durationMs: 3205484,
          inputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 1,
        },
      },
    }),
    ...extra,
  ].filter((event) => event.at <= until);
  const answered = until >= at(11, 31, 4, 810);
  return session({
    events,
    input: { id: "292ef063-4e86-d843-e044-0adaffa5c082" },
    scheduled: realSchedule,
    status: answered ? "completed" : "running",
    ...(answered
      ? {
          completedAt: at(11, 31, 4, 815),
          response: "目前 20 台容器机队的最新状态",
        }
      : {}),
  });
}

const fireStarted = realEvent(
  "evt_fire_started",
  at(11, 30, 54, 100),
  "Scheduled task fired",
  {
    metadata: {
      timerFire: {
        id: "9b17c9d2",
        origin: "scheduled",
        prompt: "巡检 20 台容器",
        startedAt: at(11, 30, 54),
        completedAt: "",
      },
    },
  },
);

test("a timer's next run follows its last wake, as Claude Code fires it (real sequence)", async () => {
  await i18n.changeLanguage("en");
  const { chatContextCardForSessions } =
    await import("../src/features/chat/chat-context-model.ts");
  const { timerNextRun } =
    await import("../src/features/chat/chat-schedule-model.ts");
  const nextAt = (until) => {
    const [timer] = chatContextCardForSessions([realSession(until)]).timers;
    return timerNextRun(
      timer.scheduled,
      timer.wake,
      timer.busy,
      new Date(until),
    );
  };
  // The process the device's fire resumed brought the timer back as fired
  // at 10:37:27: due at 10:58 + 9 min 5 s, while that turn still ran, so
  // it ran as the turn ended (11:30:53), not at 11:37:05 nor at 11:58.
  const busy = nextAt(at(11, 20));
  assert.equal(busy.due, true);
  // Then it fired as the process went idle (a run older workers did not
  // publish): next at 11:58 + 9 min 5 s.
  const idle = nextAt(at(11, 45));
  assert.equal(idle.due, false);
  assert.equal(
    idle.at.getTime(),
    new Date(2026, 9, 12, 12, 7, 5, 248).getTime(),
  );

  // The panel note says the same.
  const { scheduledNote, threadScheduleWakes, liveThreadSchedule } =
    await import("../src/features/chat/chat-schedule-model.ts");
  const sessions = [realSession(at(11, 45))];
  const { wakes, busy: threadBusy } = threadScheduleWakes(sessions);
  assert.equal(
    scheduledNote(
      liveThreadSchedule(sessions),
      new Date(at(11, 45)),
      wakes,
      threadBusy,
    ),
    "1 scheduled task · next at 12:07",
  );
});

test("a timer's run history shows when each run fired and the answer its turn gave (real sequence)", async () => {
  const { chatContextCardForSessions } =
    await import("../src/features/chat/chat-context-model.ts");
  const [timer] = chatContextCardForSessions([realSession(at(11, 45))]).timers;
  assert.equal(timer.fires.length, 1);
  assert.equal(timer.fires[0].startedAt, at(10, 37, 27, 296));
  assert.equal(timer.fires[0].completedAt, at(11, 31, 4, 810));
  assert.equal(timer.fires[0].response, "目前 20 台容器机队的最新状态");
  // While its turn runs, it has no answer yet.
  const [running] = chatContextCardForSessions([
    realSession(at(11, 20)),
  ]).timers;
  assert.equal(running.fires[0].completedAt, "");
  assert.equal(running.fires[0].response, undefined);
});

test("a run Claude starts on its own shows as running background work, then as one run with its answer", async () => {
  await i18n.changeLanguage("en");
  const {
    backgroundWorkNote,
    chatContextCardForSessions,
    runningBackgroundWork,
  } = await import("../src/features/chat/chat-context-model.ts");
  const { timerNextRun } =
    await import("../src/features/chat/chat-schedule-model.ts");
  const now = new Date(at(11, 45));
  const card = chatContextCardForSessions([
    realSession(at(11, 45), [fireStarted]),
  ]);
  const [timer] = card.timers;
  assert.equal(timer.running.startedAt, at(11, 30, 54));
  assert.equal(timer.busy, true);
  assert.deepEqual(
    timerNextRun(timer.scheduled, timer.wake, timer.busy, now).at.getTime(),
    new Date(2026, 9, 12, 12, 7, 5, 248).getTime(),
  );
  const work = runningBackgroundWork(card);
  assert.equal(work.timerRun.id, timer.id);
  assert.equal(
    backgroundWorkNote(work, now),
    "Scheduled task running since 11:30",
  );

  const fireEnded = realEvent(
    "evt_fire_ended",
    at(12, 10),
    "Scheduled task fired",
    {
      metadata: {
        timerFire: {
          ...fireStarted.metadata.timerFire,
          response: "巡检完成",
          completedAt: at(12, 10),
        },
      },
    },
  );
  const ended = chatContextCardForSessions([
    realSession(at(12, 10), [fireStarted, fireEnded]),
  ]);
  const [done] = ended.timers;
  assert.equal(done.running, undefined);
  assert.equal(runningBackgroundWork(ended).timerRun, undefined);
  assert.deepEqual(
    done.fires.map((fire) => [fire.startedAt, fire.response]),
    [
      [at(11, 30, 54), "巡检完成"],
      [at(10, 37, 27, 296), "目前 20 台容器机队的最新状态"],
    ],
  );
  const entries = sessionTranscriptEntries(
    realSession(at(12, 10), [fireStarted, fireEnded]),
  );
  assert.equal(
    entries.filter(
      (entry) =>
        entry.kind === "boundary" &&
        entry.text.startsWith("⏰ Scheduled task fired"),
    ).length,
    2,
    "one divider per run",
  );
  assert.ok(entries.some((entry) => entry.text === "巡检完成"));
});

test("a run the device sent, read for the panel alone, is answered by its turn and never shows as running", async () => {
  const { chatContextCardForSessions } =
    await import("../src/features/chat/chat-context-model.ts");
  const full = realSession(at(11, 45));
  const fire = full.events.find((event) => event.id === "evt_input");
  const finished = full.events.find((event) => event.id === "evt_finished");
  // The window holds only later events; the server sends the input's fire
  // and the turn's usage as state events, without message or answer.
  const windowed = {
    ...full,
    events: [snapshotEvent("evt_snapshot", [inspection])],
    stateEvents: [
      { ...fire, message: undefined },
      { ...finished, detail: "" },
    ],
    input: { ...full.input, timerFire: fire.metadata.timerFire },
  };
  const [timer] = chatContextCardForSessions([windowed]).timers;
  assert.equal(timer.running, undefined);
  assert.equal(timer.fires.length, 1);
  assert.equal(timer.fires[0].response, "目前 20 台容器机队的最新状态");
});

test("a process that resumed the session holds the timer as fired then: one run per slot (isolated real run)", async () => {
  // Claude Code 2.1.295 on an isolated stack, cron */3 (id 0538b46f fires
  // 1.8 s after each slot): the worker restarted, the device sent the 04:21
  // fire at 04:21:13, which resumed the session; Claude next fired it at
  // 04:24:01.88, not right after that turn.
  const { chatContextCardForSessions } =
    await import("../src/features/chat/chat-context-model.ts");
  const { timerNextRun } =
    await import("../src/features/chat/chat-schedule-model.ts");
  const utc = (m, s, ms = 0) =>
    new Date(Date.UTC(2026, 9, 12, 4, m, s, ms)).toISOString();
  const fired = utc(21, 13, 608);
  const resumed = session({
    status: "completed",
    scheduled: {
      reportedAt: utc(14, 39),
      timers: [
        {
          id: "0538b46f",
          kind: "cron",
          schedule: "*/3 * * * *",
          recurring: true,
          firstSeenAt: utc(14, 39, 41),
        },
      ],
    },
    events: [
      snapshotEvent("evt_snapshot", [
        { ...inspection, id: "0538b46f", schedule: "*/3 * * * *" },
      ]),
      realEvent("evt_input", fired, "User message", {
        message: { id: "in_1", at: fired, kind: "user", text: "TIMER-PING" },
        metadata: {
          timerFire: {
            id: "0538b46f",
            origin: "scheduled",
            prompt: "TIMER-PING",
            startedAt: fired,
            completedAt: "",
          },
        },
      }),
      realEvent("evt_started", utc(21, 13, 799), "Started Claude Agent SDK"),
      realEvent("evt_answer", utc(21, 16, 481), "Response stream", {
        detail: "PONG",
      }),
      realEvent("evt_done", utc(21, 16, 528), "Claude Agent SDK finished", {
        metadata: {
          turnUsage: {
            durationMs: 2900,
            inputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 1,
          },
        },
      }),
    ],
  });
  const [timer] = chatContextCardForSessions([resumed]).timers;
  const next = timerNextRun(
    timer.scheduled,
    timer.wake,
    timer.busy,
    new Date(utc(22, 0)),
  );
  assert.equal(next.due, false);
  assert.equal(next.at.toISOString(), "2026-10-12T04:24:01.835Z");
});

test("a scheduled run that failed because the context is full and compaction failed shows on the note and in the history (real sequence)", async () => {
  await i18n.changeLanguage("en");
  const { chatContextCardForSessions } =
    await import("../src/features/chat/chat-context-model.ts");
  const { scheduledNote, threadScheduleWakes, liveThreadSchedule } =
    await import("../src/features/chat/chat-schedule-model.ts");
  // sess_1791532977920187026 on 2026-10-13: Claude Code fired the timer,
  // the context was full and its gateway failed the compaction request.
  const response =
    "Prompt is too long · automatic compaction failed: API Error: 400 User location is not supported for the API use.";
  const fireFailed = realEvent(
    "evt_fire_failed",
    at(11, 32, 30),
    "Scheduled task fired",
    {
      level: "error",
      metadata: {
        timerFire: {
          ...fireStarted.metadata.timerFire,
          response,
          completedAt: at(11, 32, 30),
        },
      },
    },
  );
  const sessions = [realSession(at(11, 45), [fireStarted, fireFailed])];
  const { wakes, busy, failedRun } = threadScheduleWakes(sessions);
  assert.equal(failedRun?.response, response);
  assert.equal(
    scheduledNote(
      liveThreadSchedule(sessions),
      new Date(at(11, 45)),
      wakes,
      busy,
      failedRun,
    ),
    "1 scheduled task · next at 12:07 · last run failed: context full, compaction failed",
  );
  const [timer] = chatContextCardForSessions(sessions).timers;
  assert.deepEqual(
    timer.fires.map((fire) => Boolean(fire.failed)),
    [true, false],
  );

  // A later run that succeeds clears it.
  const fireOk = realEvent("evt_fire_ok", at(12, 9), "Scheduled task fired", {
    metadata: {
      timerFire: {
        ...fireStarted.metadata.timerFire,
        startedAt: at(12, 7, 5),
        response: "巡检完成",
        completedAt: at(12, 9),
      },
    },
  });
  const recovered = threadScheduleWakes([
    realSession(at(12, 10), [fireStarted, fireFailed, fireOk]),
  ]);
  assert.equal(recovered.failedRun, undefined);
});
