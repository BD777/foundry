import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { panel } from "./fixtures/session-panel.mjs";

register("./bundler-resolve.mjs", import.meta.url);

class FakeEventSource {
  static last;
  constructor() {
    FakeEventSource.last = this;
  }
  addEventListener() {}
  close() {}
}
globalThis.EventSource = FakeEventSource;

const {
  backgroundWorkNote,
  chatContextCardForSessions,
  runningBackgroundWork,
} = await import("../src/features/chat/context/chat-context-model.ts");
const { createStreamTouchLedger } =
  await import("../src/app/stream-touches.ts");
const { hiddenFlushMs, useFoundryLiveData } =
  await import("../src/app/use-foundry-live-data.ts");
const { setDocumentChat, setDocumentPage } =
  await import("../src/lib/document-title.ts");

const minute = (n) => `2026-10-10T06:${String(n).padStart(2, "0")}:00.000Z`;

function event(id, at, label, detail) {
  return { at, detail, id, label, level: "info", sessionId: "sess" };
}

const command = {
  id: "bg1",
  provider: "claude",
  kind: "command",
  description: "Run the suite",
  status: "running",
  startedAt: minute(2),
  hasOutput: true,
};
const subagent = {
  id: "evt_subagent",
  taskId: "agent_1",
  toolUseId: "toolu_1",
  detail: "Review the change",
  status: "running",
};
/** The panel the server derives as the command and the subagent run. */
const workPanel = ({ commandStatus, subagentStatus }) =>
  panel({
    focus: true,
    background: [{ task: { ...command, status: commandStatus } }],
    subagents: [{ ...subagent, status: subagentStatus }],
    busy: commandStatus === "running",
  });

/**
 * A chat whose turn ended long ago: the transcript window holds only its
 * answer; the background command and subagent started before it, and the
 * panel the read brought says they run.
 */
const chat = {
  agentId: "agent",
  createdLabel: "",
  deviceId: "dev",
  events: [event("evt_answer", minute(40), "Response stream", "Started both")],
  panel: workPanel({ commandStatus: "running", subagentStatus: "running" }),
  id: "sess",
  prompt: "patrol",
  provider: "claude",
  status: "completed",
  title: "Patrol",
  updatedLabel: "completed",
  workspaceId: "ws",
};

const touches = createStreamTouchLedger();

/**
 * The open chat's tab marks as the chat view derives them: the side panel's
 * rows (use-chat-feature) and the note they make (chat-surface).
 */
function OpenChat({ data }) {
  const [shown, setData] = useState(data);
  useFoundryLiveData({
    activeSession: false,
    devices: [],
    enabled: true,
    onRefresh: () => {},
    setData,
    touches,
    workspaceId: "ws",
  });
  const card = chatContextCardForSessions(shown.agentSessions);
  // What the composer's "running in the background" note says.
  const background = backgroundWorkNote(runningBackgroundWork(card)) !== "";
  useEffect(() => {
    setDocumentChat({ title: "Patrol", running: false, background });
  }, [background]);
  useEffect(() => () => setDocumentChat(undefined), []);
  return null;
}

test("background work the panel shows marks the tab, and its end clears it in a hidden tab", async (t) => {
  const window = new Window({ url: "http://127.0.0.1/" });
  const previous = new Map();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  window.setTimeout = (...args) => globalThis.setTimeout(...args);
  window.clearTimeout = (id) => globalThis.clearTimeout(id);
  window.setInterval = (...args) => globalThis.setInterval(...args);
  window.clearInterval = (id) => globalThis.clearInterval(id);
  let visibility = "visible";
  // Like browsers: no animation frames while the tab is hidden.
  window.requestAnimationFrame = (callback) =>
    visibility === "hidden" ? -1 : setTimeout(callback, 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  Object.defineProperty(window.document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  window.document.head.innerHTML =
    '<link rel="icon" type="image/png" href="/foundry-icon.png" />';
  const icon = window.document.querySelector('link[rel~="icon"]');
  setDocumentPage({ primary: "Chats", context: "ws" });
  const root = createRoot(window.document.createElement("div"));
  const data = {
    workspace: { id: "ws" },
    devices: [],
    issues: [],
    agentSessions: [chat],
  };
  try {
    await act(() => root.render(createElement(OpenChat, { data })));
    assert.equal(window.document.title, "⚙️ Patrol · ws — Foundry");
    assert.equal(icon.getAttribute("href"), "/foundry-icon-background.png");

    const source = FakeEventSource.last;
    await act(async () => source.onopen());
    visibility = "hidden";
    await act(() =>
      window.document.dispatchEvent(new window.Event("visibilitychange")),
    );
    let id = 0;
    const stream = (sessionPanel) =>
      act(() =>
        source.onmessage({
          lastEventId: `ep-${++id}`,
          data: JSON.stringify({
            type: "agent_session_panel",
            payload: {
              workspaceId: "ws",
              sessionId: "sess",
              panel: sessionPanel,
            },
          }),
        }),
      );
    // The command ends; the subagent still runs.
    await stream(
      workPanel({ commandStatus: "completed", subagentStatus: "running" }),
    );
    await act(() => t.mock.timers.tick(hiddenFlushMs));
    assert.equal(window.document.title, "⚙️ Patrol · ws — Foundry");
    await stream(
      workPanel({ commandStatus: "completed", subagentStatus: "completed" }),
    );
    assert.equal(
      icon.getAttribute("href"),
      "/foundry-icon-background.png",
      "applied on the hidden-tab timer, not at once",
    );
    await act(() => t.mock.timers.tick(hiddenFlushMs));
    assert.equal(window.document.title, "Patrol · ws — Foundry");
    assert.equal(icon.getAttribute("href"), "/foundry-icon.png");
  } finally {
    await act(() => root.unmount());
    t.mock.timers.tick(1100);
    t.mock.timers.reset();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await window.happyDOM.close();
  }
});
