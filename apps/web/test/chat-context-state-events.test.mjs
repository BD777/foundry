import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { panel } from "./fixtures/session-panel.mjs";

register("./bundler-resolve.mjs", import.meta.url);
const { chatContextCardForSessions } =
  await import("../src/features/chat/context/chat-context-model.ts");
const { mergeLoadedAgentSession } =
  await import("../src/lib/agent-session-events.ts");
const { applyFoundryStreamEvent } =
  await import("../src/app/foundry-data-projection.ts");

// The server derives the side panel from the session's state events
// (apps/server/internal/store/session_panel_test.go). Here: how the web
// keeps the panel a read or the stream brings, and renders it.

const minute = (n) => `2026-10-10T06:${String(n).padStart(2, "0")}:00.000Z`;

function event(id, at, label, detail) {
  return { at, detail, id, label, level: "info", sessionId: "sess_state" };
}

function session(events, sessionPanel, overrides = {}) {
  return {
    agentId: "agent_test",
    createdLabel: "just now",
    deviceId: "dev_test",
    events,
    ...(sessionPanel ? { panel: sessionPanel } : {}),
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
const subagent = {
  id: "evt_subagent",
  taskId: "agent_1",
  toolUseId: "toolu_1",
  detail: "Review the change",
  status: "running",
};
const unloadedRun = {
  id: cron.id,
  origin: "scheduled",
  completedAt: minute(28),
  answerUnloaded: true,
};
const windowPanel = panel({
  focus: true,
  subagents: [subagent],
  timers: [{ task: cron, runs: [unloadedRun] }],
  timerSnapshotAt: minute(1),
});
const newest = [
  event("evt_answer", minute(40), "Response stream", "Still patrolling"),
];
const subagentStart = event(
  "evt_subagent",
  minute(4),
  "Starting subtask",
  "Review the change",
);

test("a page of older events keeps the panel a window read brought", () => {
  const shown = mergeLoadedAgentSession(
    undefined,
    session(newest, undefined, { status: "completed" }),
  );
  const windowed = mergeLoadedAgentSession(
    shown,
    session(newest, windowPanel, { status: "completed" }),
  );
  assert.equal(windowed.panel, windowPanel);
  const page = mergeLoadedAgentSession(
    windowed,
    session([subagentStart], undefined, { status: "completed" }),
  );
  assert.equal(page.panel, windowPanel);
  assert.deepEqual(
    page.events.map((item) => item.id),
    ["evt_subagent", "evt_answer"],
  );
  // A live session update without events keeps it as well.
  const summary = { ...session(undefined), status: "completed" };
  delete summary.events;
  assert.equal(mergeLoadedAgentSession(page, summary).panel, windowPanel);
  // A newer window's panel replaces it.
  const repaired = panel({ subagents: [{ ...subagent, status: "completed" }] });
  assert.equal(
    mergeLoadedAgentSession(
      page,
      session(newest, repaired, { status: "completed" }),
    ).panel,
    repaired,
  );
});

test("agent_session_panel replaces the panel the card shows", () => {
  const data = {
    agentSessions: [session(newest, windowPanel)],
    assets: [],
    chats: [],
    devices: [],
    issues: [],
    providerHealth: [],
    workspace: { id: "ws_test", name: "ws_test" },
    workspaces: [],
  };
  const live = panel({
    focus: true,
    subagents: [{ ...subagent, status: "completed" }],
  });
  const next = applyFoundryStreamEvent(data, {
    type: "agent_session_panel",
    payload: { workspaceId: "ws_test", sessionId: "sess_state", panel: live },
  });
  const [updated] = next.agentSessions;
  assert.equal(updated.panel, live);
  // The transcript stays as loaded.
  assert.equal(updated.events, data.agentSessions[0].events);
  const card = chatContextCardForSessions([updated]);
  assert.deepEqual(card?.timers, []);
  assert.deepEqual(
    card?.subagents.map((item) => [item.taskId, item.status]),
    [["agent_1", "completed"]],
  );
  // A panel for a session not shown changes nothing.
  assert.equal(
    applyFoundryStreamEvent(next, {
      type: "agent_session_panel",
      payload: { workspaceId: "ws_test", sessionId: "sess_other", panel: live },
    }),
    next,
  );
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
      await import("../src/features/chat/detail/chat-detail-panel.tsx");
    const card = chatContextCardForSessions([
      session(
        newest,
        panel({
          focus: true,
          timers: [
            {
              task: cron,
              runs: [
                { id: cron.id, origin: "scheduled", completedAt: minute(59) },
                {
                  id: cron.id,
                  origin: "scheduled",
                  completedAt: minute(58),
                  response: "All quiet.",
                },
                unloadedRun,
              ],
            },
          ],
          timerSnapshotAt: minute(1),
        }),
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
