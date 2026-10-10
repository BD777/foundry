import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);
const { chatContextCardForSessions, runningBackgroundWork } =
  await import("../src/features/chat/chat-context-model.ts");
const { mergeLoadedAgentSession } =
  await import("../src/lib/agent-session-events.ts");
const { appendAgentEvents } = await import("../src/lib/agent-event-log.ts");

const minute = (n) => `2026-10-10T06:${String(n).padStart(2, "0")}:00.000Z`;

function event(id, at, label, detail, metadata) {
  return {
    at,
    detail,
    id,
    label,
    level: "info",
    metadata,
    sessionId: "sess_state",
  };
}

function session(events, stateEvents, overrides = {}) {
  return {
    agentId: "agent_test",
    createdLabel: "just now",
    deviceId: "dev_test",
    events,
    ...(stateEvents ? { stateEvents } : {}),
    id: "sess_state",
    prompt: "patrol the fleet",
    provider: "claude",
    status: "running",
    title: "Patrol",
    updatedLabel: "running",
    workspaceId: "ws_test",
    ...overrides,
  };
}

const cron = {
  humanSchedule: "every 30 minutes",
  id: "9b17c9d2",
  kind: "cron",
  prompt: "Patrol the containers",
  recurring: true,
  schedule: "28,58 * * * *",
};
const timers = (at, tasks = [cron]) =>
  event(`evt_timers_${at}`, at, "Scheduled tasks updated", "", {
    timerSnapshot: tasks,
  });
const backgroundTask = {
  id: "bg1",
  provider: "claude",
  kind: "command",
  description: "Run the suite",
  status: "running",
  startedAt: minute(2),
  hasOutput: true,
};
const recordedFile = (id, at, path, inputId = "input_1") =>
  event(id, at, "Recorded file", "", {
    sessionFile: {
      path,
      workspacePath: path.slice(1),
      origin: "tool",
      op: "created",
      inGitRepo: false,
      inputId,
    },
  });
const subagentStart = event(
  "evt_subagent",
  minute(4),
  "Starting subtask",
  "Review the change",
  { taskId: "agent_1", taskType: "local_agent", toolUseId: "toolu_1" },
);
const subagentProgress = event(
  "evt_subagent_progress",
  minute(5),
  "Subtask running",
  "",
  {
    taskId: "agent_1",
    subagentUsage: { totalTokens: 900, toolUses: 2, durationMs: 1000 },
  },
);
const fire = (at, response) =>
  event(`evt_fire_${at}`, at, "Scheduled task fired", "", {
    timerFire: {
      id: cron.id,
      origin: "scheduled",
      completedAt: at,
      ...(response ? { response } : {}),
    },
  });

/** What a windowed read sends: the state events, then the newest events. */
const stateEvents = [
  timers(minute(1)),
  event("evt_background", minute(2), "Background tasks updated", "", {
    backgroundTaskSnapshot: [backgroundTask],
  }),
  recordedFile("evt_file", minute(3), "/repo/report.md"),
  subagentStart,
  subagentProgress,
  fire(minute(28)),
];
const newest = [
  event("evt_answer", minute(40), "Response stream", "Still patrolling"),
];

test("the panel shows state older than the loaded events", () => {
  const card = chatContextCardForSessions([session(newest, stateEvents)]);
  assert.deepEqual(
    card?.timers.map((timer) => [timer.task.id, timer.fires.length]),
    [[cron.id, 1]],
  );
  assert.equal(card?.timers[0]?.fires[0]?.answerUnloaded, true);
  assert.deepEqual(
    card?.background.map((item) => [item.task.id, item.task.status]),
    [["bg1", "running"]],
  );
  assert.deepEqual(
    card?.files.map((file) => file.path),
    ["/repo/report.md"],
  );
  assert.deepEqual(
    card?.subagents.map((subagent) => [
      subagent.taskId,
      subagent.label,
      subagent.status,
      subagent.usage?.totalTokens,
    ]),
    [["agent_1", "Review the change", "running", 900]],
  );
  // The "running in the background" note counts them too.
  assert.deepEqual(runningBackgroundWork(card), {
    taskIds: ["sess_state:background:bg1"],
    subagentIds: ["evt_subagent"],
  });
  // Without state events the window alone shows nothing (an older server).
  assert.equal(chatContextCardForSessions([session(newest)]), undefined);
});

test("live events keep updating state that came before the window", () => {
  const live = appendAgentEvents(newest, [
    event("evt_subagent_end", minute(41), "Subtask completed", "Done", {
      taskId: "agent_1",
    }),
    recordedFile("evt_file_live", minute(42), "/repo/notes.md", "input_2"),
    event("evt_background_live", minute(43), "Background tasks updated", "", {
      backgroundTaskSnapshot: [
        { ...backgroundTask, status: "completed", endedAt: minute(43) },
      ],
    }),
    timers(minute(44), []),
  ]);
  const card = chatContextCardForSessions([session(live, stateEvents)]);
  assert.deepEqual(card?.timers, []);
  assert.deepEqual(
    card?.background.map((item) => item.task.status),
    ["completed"],
  );
  assert.deepEqual(
    card?.files.map((file) => file.path),
    ["/repo/notes.md", "/repo/report.md"],
  );
  assert.deepEqual(
    card?.subagents.map((subagent) => subagent.status),
    ["completed"],
  );
  assert.deepEqual(runningBackgroundWork(card), {
    taskIds: [],
    subagentIds: [],
  });
});

test("a state event loaded since is read once, from the loaded events", () => {
  const answered = fire(minute(28), "All 20 containers are busy.");
  const paged = [
    ...stateEvents.filter((item) => item.id !== answered.id),
    answered,
    ...newest,
  ];
  const card = chatContextCardForSessions([session(paged, stateEvents)]);
  const [timer] = card?.timers ?? [];
  assert.equal(timer?.fires.length, 1);
  assert.equal(timer?.fires[0]?.response, "All 20 containers are busy.");
  assert.equal(timer?.fires[0]?.answerUnloaded, undefined);
  assert.equal(card?.subagents.length, 1);
  assert.deepEqual(card?.files[0]?.turnIds, ["input_1"]);
});

test("state events take their place by time among the loaded events", () => {
  // A repair read after missed events: its state holds a snapshot newer
  // than the one loaded first.
  const loaded = [
    timers(minute(1)),
    event("evt_answer_old", minute(2), "Response stream", "answer"),
    event("evt_answer_new", minute(50), "Response stream", "answer"),
  ];
  const card = chatContextCardForSessions([
    session(loaded, [timers(minute(30), [])]),
  ]);
  assert.equal(card, undefined);
});

test("a page of older events keeps the state events a window read brought", () => {
  const shown = mergeLoadedAgentSession(
    undefined,
    session(newest, undefined, { status: "completed" }),
  );
  const windowed = mergeLoadedAgentSession(
    shown,
    session(newest, stateEvents, { status: "completed" }),
  );
  assert.equal(windowed.stateEvents, stateEvents);
  const page = mergeLoadedAgentSession(
    windowed,
    session([subagentStart], undefined, { status: "completed" }),
  );
  assert.equal(page.stateEvents, stateEvents);
  assert.deepEqual(
    page.events.map((item) => item.id),
    ["evt_subagent", "evt_answer"],
  );
  // A live session update without events keeps them as well.
  const summary = { ...session(undefined), status: "completed" };
  delete summary.events;
  assert.equal(mergeLoadedAgentSession(page, summary).stateEvents, stateEvents);
  // A newer window's state replaces them.
  const repaired = mergeLoadedAgentSession(
    page,
    session(newest, [subagentStart], { status: "completed" }),
  );
  assert.deepEqual(repaired.stateEvents, [subagentStart]);
});

async function withDom(body) {
  const { Window } = await import("happy-dom");
  const { act } = await import("react");
  const window = new Window({ url: "http://127.0.0.1/" });
  const previous = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of [
    "Node",
    "Element",
    "HTMLElement",
    "Event",
    "getComputedStyle",
  ])
    globals[key] = window[key];
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  try {
    const { createRoot } = await import("react-dom/client");
    const { i18n } = await import("../src/i18n/index.ts");
    await i18n.changeLanguage("en");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await body(container, root, act);
    await act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    await window.happyDOM.close();
  }
}

test("a run whose turn is not loaded says where its answer is", async () => {
  await withDom(async (container, root, act) => {
    const { createElement } = await import("react");
    const { ChatDetailPanel } =
      await import("../src/features/chat/chat-detail-panel.tsx");
    const card = chatContextCardForSessions([
      session(
        [...newest, fire(minute(58), "All quiet."), fire(minute(59))],
        stateEvents,
      ),
    ]);
    const timer = card?.timers[0];
    assert.equal(timer?.fires.length, 3);
    await act(async () =>
      root.render(
        createElement(ChatDetailPanel, {
          loading: false,
          onClose: () => {},
          selection: timer,
        }),
      ),
    );
    const runs = [...container.querySelectorAll(".fdy-chat-timer-fire")].map(
      (run) => run.textContent,
    );
    assert.equal(runs.length, 3);
    assert.match(runs[0], /This run returned no text\./);
    assert.match(runs[1], /All quiet\./);
    assert.match(runs[2], /This run's answer is further up in the chat\./);
  });
});
