import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

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

const { agentSessionBehindActivity, agentSessionLacksDetails } =
  await import("../src/lib/agent-session-events.ts");
const { useChatTranscript } =
  await import("../src/features/chat/use-chat-transcript.ts");

const event = (id, at) => ({
  id,
  sessionId: "s",
  at,
  label: "Response stream",
  detail: "text",
  level: "info",
});
const session = (extra) => ({
  id: "s",
  workspaceId: "ws",
  agentId: "a",
  deviceId: "d",
  provider: "claude",
  prompt: "p",
  title: "t",
  createdLabel: "",
  updatedLabel: "",
  status: "running",
  events: [event("e1", "2026-10-10T00:00:00.000Z")],
  ...extra,
});

test("a summary newer than the events is told apart from missing details", () => {
  const behind = session({ lastActivityAt: "2026-10-10T00:00:00.500Z" });
  assert.equal(agentSessionBehindActivity(behind), true);
  assert.equal(agentSessionLacksDetails(behind), false);
  const finished = session({ status: "completed", response: "" });
  assert.equal(agentSessionLacksDetails(finished), true, "no answer yet");
  assert.equal(agentSessionBehindActivity(finished), false);
  assert.equal(agentSessionLacksDetails(session({ events: undefined })), true);
});

test("transcript: with live events arriving, a time mismatch loads nothing", async (t) => {
  const window = new Window();
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
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const loads = [];
  const transport = {
    loadRecent: async (threadId) => {
      loads.push(threadId);
      return [session({})];
    },
    loadEarlier: async () => session({}),
  };
  function Harness({ sessions }) {
    useChatTranscript({
      onLoaded: () => {},
      sessions,
      threadId: "s",
      workspaceId: "ws",
      transport,
    });
    return null;
  }
  const root = createRoot(window.document.createElement("div"));
  const render = (sessions) =>
    act(async () => {
      root.render(createElement(Harness, { sessions }));
      await new Promise((resolve) => setImmediate(resolve));
    });
  const elapse = (ms) =>
    act(async () => {
      t.mock.timers.tick(ms);
      await new Promise((resolve) => setImmediate(resolve));
    });
  try {
    // First visit: the transcript is not loaded yet; the load waits for
    // the stream, so nothing it sends after the load is missed.
    await render([session({})]);
    assert.equal(loads.length, 0, "missing: waits for the stream");
    const source = FakeEventSource.last;
    await act(async () => {
      source.onopen();
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.equal(loads.length, 1, "loaded once, after the stream opened");
    await act(() =>
      source.onmessage({
        lastEventId: "ep-0",
        data: JSON.stringify({
          type: "chat_titles_changed",
          payload: { workspaceId: "ws" },
        }),
      }),
    );

    // The summary's activity time runs ahead of the streamed events.
    await elapse(60_000);
    await render([session({ lastActivityAt: "2026-10-10T00:00:01.000Z" })]);
    assert.equal(
      loads.length,
      1,
      "stream delivering: a time mismatch is no gap",
    );

    // A finished session without its answer is genuinely missing it.
    await render([session({ status: "completed", response: "" })]);
    assert.equal(loads.length, 2, "missing answer: loaded");

    // With the stream down, the summary is all there is: repair (limited).
    await render([session({})]);
    await elapse(60_000);
    await act(() => source.onerror());
    await render([session({ lastActivityAt: "2026-10-10T00:00:02.000Z" })]);
    assert.equal(loads.length, 3, "stream down: the gap is repaired");

    // Back up, resuming after ep-0: nothing to load. A resync does load.
    await elapse(60_000);
    await act(() => source.onopen());
    assert.equal(loads.length, 3, "resumed: the server replays instead");
    await act(async () => {
      source.onmessage({
        lastEventId: "ep-1",
        data: JSON.stringify({
          type: "resync",
          payload: { reason: "expired" },
        }),
      });
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.equal(loads.length, 4, "resync: reloaded");
  } finally {
    await act(() => root.unmount());
    // The connection closes once nobody listens.
    t.mock.timers.tick(1100);
    t.mock.timers.reset();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await window.happyDOM.close();
  }
});

test("transcript: a load made before a late stream opened is made again once it opens", async (t) => {
  const window = new Window();
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
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const { foundryStreamOpenWaitMs } = await import("../src/stream/index.ts");
  const loads = [];
  const transport = {
    loadRecent: async (threadId) => {
      loads.push(threadId);
      return [session({ id: "s2" })];
    },
    loadEarlier: async () => session({ id: "s2" }),
  };
  function Harness() {
    useChatTranscript({
      onLoaded: () => {},
      sessions: [session({ id: "s2", events: undefined })],
      threadId: "s2",
      workspaceId: "ws",
      transport,
    });
    return null;
  }
  const root = createRoot(window.document.createElement("div"));
  const step = (run) =>
    act(async () => {
      run();
      await new Promise((resolve) => setImmediate(resolve));
    });
  try {
    await step(() => root.render(createElement(Harness)));
    assert.equal(loads.length, 0);
    const source = FakeEventSource.last;
    await step(() => t.mock.timers.tick(foundryStreamOpenWaitMs));
    assert.equal(loads.length, 1, "a slow stream does not keep it empty");
    await step(() => source.onopen());
    assert.equal(loads.length, 2, "loaded again once the stream opened");
    await step(() => t.mock.timers.tick(60_000));
    assert.equal(loads.length, 2);
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
