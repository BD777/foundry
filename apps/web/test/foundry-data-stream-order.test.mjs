import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement, useState } from "react";
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

const { singleFlight } = await import("../src/lib/single-flight.ts");
const { createStreamTouchLedger } =
  await import("../src/app/stream-touches.ts");
const { applyFoundryStreamEvents, mergeLoadedFoundryData, streamedDevice } =
  await import("../src/app/foundry-data-projection.ts");
const {
  dataChangeRefreshDelayMs,
  deviceEventNeedsRefresh,
  deviceRefreshDelayMs,
  hiddenFlushMs,
  streamSilenceMs,
  useFoundryLiveData,
} = await import("../src/app/use-foundry-live-data.ts");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("single flight: one run at a time, callers meanwhile share one more run", async () => {
  const runs = [];
  const run = singleFlight(() => {
    const next = deferred();
    runs.push(next);
    return next.promise;
  });
  const first = run();
  const second = run();
  const third = run();
  assert.equal(runs.length, 1, "no second request beside the first");
  assert.equal(second, third, "waiting callers share the next run");
  runs[0].resolve("a");
  assert.equal(await first, "a");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs.length, 2, "the queued run starts after the first ends");
  runs[1].resolve("b");
  assert.equal(await second, "b", "a caller gets a run that began after it");
  assert.equal(runs.length, 2, "three calls, two requests");

  // A failed run does not block the one queued behind it.
  const failing = run();
  const after = run();
  runs[2].reject(new Error("offline"));
  await assert.rejects(failing, /offline/);
  await new Promise((resolve) => setImmediate(resolve));
  runs[3].resolve("c");
  assert.equal(await after, "c");
});

const session = (id, status, extra = {}) => ({
  id,
  status,
  workspaceId: "ws",
  agentId: "agent",
  deviceId: "dev",
  provider: "claude",
  prompt: "p",
  title: id,
  createdLabel: "",
  updatedLabel: status,
  ...extra,
});

function data(sessions, extra = {}) {
  return {
    workspace: { id: "ws" },
    devices: [],
    issues: [],
    agentSessions: sessions,
    ...extra,
  };
}

test("single flight: a run that stalls is aborted after its timeout; the queued run goes on", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signals = [];
  const answers = [];
  const run = singleFlight(
    (signal) => {
      signals.push(signal);
      const next = deferred();
      answers.push(next);
      signal.addEventListener("abort", () => next.reject(signal.reason));
      return next.promise;
    },
    { timeoutMs: 1000 },
  );
  const stalled = run();
  const queued = run();
  t.mock.timers.tick(999);
  assert.equal(signals[0].aborted, false);
  t.mock.timers.tick(1);
  await assert.rejects(stalled, { name: "TimeoutError" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signals.length, 2, "the queued run started");
  answers[1].resolve("fresh");
  assert.equal(await queued, "fresh");
  t.mock.timers.tick(5000);
  assert.equal(signals[1].aborted, false, "a run that answered is not aborted");
  t.mock.timers.reset();
});

test("an older snapshot never overwrites what live events changed after it started", () => {
  const touches = createStreamTouchLedger();
  let shown = data([session("s1", "running"), session("s2", "running")]);
  // A read starts; the server builds its snapshot now.
  const mark = touches.mark();
  const snapshot = data([
    session("s1", "running"),
    session("s2", "running", { title: "renamed" }),
  ]);
  // Meanwhile the stream says s1 completed and a new session s3 started.
  const streamed = [
    {
      type: "agent_session_completed",
      payload: session("s1", "completed", { response: "done" }),
    },
    { type: "agent_session_created", payload: session("s3", "queued") },
  ];
  streamed.forEach((event) => touches.record(event));
  shown = applyFoundryStreamEvents(shown, streamed);

  const merged = mergeLoadedFoundryData(shown, snapshot, touches.since(mark));
  const byId = Object.fromEntries(merged.agentSessions.map((s) => [s.id, s]));
  assert.equal(byId.s1.status, "completed", "not reverted to running");
  assert.equal(byId.s1.response, "done");
  assert.equal(byId.s3?.status, "queued", "a session the read missed stays");
  assert.equal(byId.s2.title, "renamed", "untouched sessions take the read");

  // Without the ordering, the same late snapshot revived the session.
  const unordered = mergeLoadedFoundryData(shown, snapshot);
  assert.equal(
    unordered.agentSessions.find((s) => s.id === "s1").status,
    "running",
  );

  // A read that started after those events is newer: it wins.
  const later = touches.mark();
  const fresh = mergeLoadedFoundryData(
    merged,
    data([session("s1", "failed"), session("s3", "running")]),
    touches.since(later),
  );
  assert.deepEqual(
    fresh.agentSessions.map((s) => [s.id, s.status]),
    [
      ["s1", "failed"],
      ["s3", "running"],
    ],
  );
});

test("a session with only new transcript events takes the read's summary, never back to queued", () => {
  const touches = createStreamTouchLedger();
  let shown = data([session("s1", "queued")]);
  const mark = touches.mark();
  const event = {
    type: "agent_session_event",
    payload: {
      id: "e1",
      sessionId: "s1",
      at: "2026-10-10T00:00:00Z",
      label: "Tool",
      detail: "ls",
      level: "info",
    },
  };
  touches.record(event);
  shown = applyFoundryStreamEvents(shown, [event]);
  assert.equal(shown.agentSessions[0].status, "running");
  const merged = mergeLoadedFoundryData(
    shown,
    data([session("s1", "queued", { title: "named" })]),
    touches.since(mark),
  );
  assert.equal(merged.agentSessions[0].status, "running");
  assert.equal(merged.agentSessions[0].title, "named", "summary from the read");
  assert.equal(merged.agentSessions[0].events.length, 1);
});

test("issues and devices changed by live events keep their streamed state", () => {
  const touches = createStreamTouchLedger();
  const device = {
    id: "dev",
    label: "Mac",
    status: "connected",
    lastSeenLabel: "online",
    owned: true,
  };
  let shown = data([], {
    devices: [device],
    issues: [{ id: "iss", workspaceId: "ws", status: "draft", title: "t" }],
  });
  const mark = touches.mark();
  const stale = data([], {
    devices: [device],
    issues: [{ id: "iss", workspaceId: "ws", status: "draft", title: "t" }],
  });
  const events = [
    {
      type: "issue_updated",
      payload: {
        id: "iss",
        workspaceId: "ws",
        status: "in_progress",
        title: "t",
      },
    },
    {
      type: "device_status_changed",
      payload: { workspaceId: "ws", deviceId: "dev", status: "disconnected" },
    },
  ];
  events.forEach((event) => touches.record(event));
  shown = applyFoundryStreamEvents(shown, events);
  const merged = mergeLoadedFoundryData(shown, stale, touches.since(mark));
  assert.equal(merged.issues[0].status, "in_progress");
  assert.equal(merged.devices[0].status, "disconnected");
  assert.equal(merged.devices[0].lastSeenLabel, "offline");
});

test("a device status event with the whole device replaces it; the viewer's own fields stay", () => {
  const runtimeSettings = { defaultProfileId: "p1" };
  const shown = data([], {
    devices: [
      {
        id: "dev",
        label: "Mac",
        status: "connected",
        lastSeenLabel: "online",
        owned: true,
        runtimeSettings,
        worker: { version: "1.0.0" },
        workerUpdate: { startedAt: "2026-10-09T00:00:00Z" },
      },
    ],
  });
  // As the server lists it to a viewer who does not own it.
  const whole = {
    id: "dev",
    label: "Mac",
    status: "disconnected",
    lastSeenLabel: "offline",
    worker: { version: "1.0.1" },
    lastDisconnect: { at: "2026-10-10T00:00:00Z" },
  };
  const payload = {
    workspaceId: "ws",
    deviceId: "dev",
    status: "disconnected",
    device: whole,
  };
  assert.deepEqual(streamedDevice(payload), whole);
  const next = applyFoundryStreamEvents(shown, [
    { type: "device_status_changed", payload },
  ]);
  assert.deepEqual(
    next.devices[0],
    { ...whole, owned: true, runtimeSettings },
    "a finished update and other fields the event leaves out are gone",
  );
  assert.equal(
    streamedDevice({ workspaceId: "ws", deviceId: "dev", status: "connected" }),
    undefined,
    "a status-only event (older servers)",
  );
});

test("device events read workspace data only for what they leave out", () => {
  const shown = {
    devices: [{ id: "dev", label: "Mac", status: "connected" }],
  };
  const event = (payload) => ({ type: "device_status_changed", payload });
  const whole = (status) => ({
    workspaceId: "ws",
    deviceId: "dev",
    status,
    device: { id: "dev", label: "Mac", status, lastSeenLabel: "x" },
  });
  assert.equal(
    deviceEventNeedsRefresh(shown, event(whole("disconnected"))),
    true,
    "a device going offline leaves its agents and profiles unusable",
  );
  assert.equal(
    deviceEventNeedsRefresh(
      { devices: [{ id: "dev", label: "Mac", status: "disconnected" }] },
      event(whole("disconnected")),
    ),
    false,
    "a device shown offline already",
  );
  assert.equal(
    deviceEventNeedsRefresh(shown, event(whole("connected"))),
    true,
    "a device online again may serve other workspaces",
  );
  assert.equal(
    deviceEventNeedsRefresh(
      shown,
      event({ workspaceId: "ws", deviceId: "dev", status: "disconnected" }),
    ),
    true,
    "status only",
  );
  assert.equal(
    deviceEventNeedsRefresh({ devices: [] }, event(whole("disconnected"))),
    true,
    "a device not listed yet",
  );
});

test("live data: reads once for device changes that need it, never per reconnect", async (t) => {
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
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // The hook's timers run on the mocked clock too.
  window.setTimeout = (...args) => globalThis.setTimeout(...args);
  window.clearTimeout = (id) => globalThis.clearTimeout(id);
  window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  let refreshes = 0;
  const touches = createStreamTouchLedger();
  const device = {
    id: "dev",
    label: "Mac",
    status: "connected",
    lastSeenLabel: "online",
  };
  function Harness() {
    const [shown, setData] = useState(data([], { devices: [device] }));
    useFoundryLiveData({
      activeSession: false,
      devices: shown.devices,
      enabled: true,
      onRefresh: () => {
        refreshes++;
      },
      setData,
      touches,
      workspaceId: "ws",
    });
    return null;
  }
  const root = createRoot(window.document.createElement("div"));
  try {
    await act(() => root.render(createElement(Harness)));
    const source = FakeEventSource.last;
    await act(() => source.onopen());
    assert.equal(refreshes, 1, "the first connection reads once");
    const send = (id, type, payload) =>
      act(() =>
        source.onmessage({
          lastEventId: id,
          data: JSON.stringify({ type, payload }),
        }),
      );
    await send("e-1", "device_status_changed", {
      workspaceId: "ws",
      deviceId: "dev",
      status: "disconnected",
      device: { ...device, status: "disconnected", lastSeenLabel: "offline" },
    });
    await act(() => t.mock.timers.tick(deviceRefreshDelayMs + 10));
    assert.equal(
      refreshes,
      2,
      "a device going offline is read: its agents and profiles go with it",
    );
    await send("e-1b", "device_status_changed", {
      workspaceId: "ws",
      deviceId: "dev",
      status: "disconnected",
      device: { ...device, status: "disconnected", lastSeenLabel: "offline" },
    });
    await act(() => t.mock.timers.tick(deviceRefreshDelayMs + 10));
    assert.equal(refreshes, 2, "a device shown offline already needs no read");
    await act(() => source.onerror());
    await act(() => source.onopen());
    assert.equal(refreshes, 2, "a resumed reconnect needs no read");
    await send("e-2", "device_status_changed", {
      workspaceId: "ws",
      deviceId: "dev",
      status: "connected",
    });
    await send("e-3", "device_status_changed", {
      workspaceId: "ws",
      deviceId: "dev",
      status: "connected",
    });
    await act(() => t.mock.timers.tick(deviceRefreshDelayMs + 10));
    assert.equal(refreshes, 3, "status-only bursts read once, after a pause");
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

test("live data: while something runs, a silent connection is reopened (no read)", async (t) => {
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
  t.mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: 2_000_000,
  });
  window.setTimeout = (...args) => globalThis.setTimeout(...args);
  window.clearTimeout = (id) => globalThis.clearTimeout(id);
  window.setInterval = (...args) => globalThis.setInterval(...args);
  window.clearInterval = (id) => globalThis.clearInterval(id);
  window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  let refreshes = 0;
  const touches = createStreamTouchLedger();
  function Harness({ activeSession }) {
    const [shown, setData] = useState(data([]));
    useFoundryLiveData({
      activeSession,
      devices: shown.devices,
      enabled: true,
      onRefresh: () => {
        refreshes++;
      },
      setData,
      touches,
      workspaceId: "ws",
    });
    return null;
  }
  const root = createRoot(window.document.createElement("div"));
  try {
    await act(() =>
      root.render(createElement(Harness, { activeSession: false })),
    );
    const first = FakeEventSource.last;
    await act(() => first.onopen());
    await act(() =>
      first.onmessage({
        lastEventId: "ep-1",
        data: JSON.stringify({
          type: "chat_titles_changed",
          payload: { workspaceId: "ws" },
        }),
      }),
    );
    const before = refreshes;
    await act(() => t.mock.timers.tick(streamSilenceMs * 2));
    assert.equal(FakeEventSource.last, first, "idle: silence is normal");
    await act(() =>
      root.render(createElement(Harness, { activeSession: true })),
    );
    await act(() => t.mock.timers.tick(streamSilenceMs / 4));
    assert.notEqual(FakeEventSource.last, first, "running: reopened");
    await act(() => FakeEventSource.last.onopen());
    assert.equal(refreshes, before, "it resumed: no read");
    await act(() => t.mock.timers.tick(streamSilenceMs / 2));
    const second = FakeEventSource.last;
    await act(() => t.mock.timers.tick(streamSilenceMs / 4));
    assert.equal(FakeEventSource.last, second, "not before a full silence");
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

test("foundry_data_changed: this workspace or all reads once per burst; others never", async (t) => {
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
  let refreshes = 0;
  const touches = createStreamTouchLedger();
  let shownData;
  function Harness() {
    const [shown, setData] = useState(data([]));
    shownData = shown;
    useFoundryLiveData({
      activeSession: false,
      devices: shown.devices,
      enabled: true,
      onRefresh: () => {
        refreshes++;
      },
      setData,
      touches,
      workspaceId: "ws",
    });
    return null;
  }
  const root = createRoot(window.document.createElement("div"));
  try {
    await act(() => root.render(createElement(Harness)));
    const source = FakeEventSource.last;
    await act(() => source.onopen());
    let id = 0;
    const changed = (workspaceId) =>
      act(() =>
        source.onmessage({
          lastEventId: `ep-${++id}`,
          data: JSON.stringify({
            type: "foundry_data_changed",
            payload: { workspaceId },
          }),
        }),
      );
    const settle = (ms = dataChangeRefreshDelayMs) =>
      act(() => t.mock.timers.tick(ms));
    await settle(1_000);
    const start = refreshes;
    const before = shownData;

    await changed("ws");
    await settle(dataChangeRefreshDelayMs - 1);
    assert.equal(refreshes, start, "waits for a quiet period");
    await settle(1);
    assert.equal(refreshes, start + 1, "this workspace: one read");
    assert.equal(shownData, before, "the event itself changes no data");

    await changed("");
    await settle();
    assert.equal(refreshes, start + 2, "a global change: one read");

    await changed("ws_other");
    await settle(10_000);
    assert.equal(refreshes, start + 2, "another workspace: no read");

    for (let index = 0; index < 5; index++) {
      await changed(index % 2 ? "" : "ws");
      await settle(100);
    }
    await settle();
    assert.equal(refreshes, start + 3, "a burst: one read");

    // A device coming online in the same burst shares that read.
    await act(() =>
      source.onmessage({
        lastEventId: `ep-${++id}`,
        data: JSON.stringify({
          type: "device_status_changed",
          payload: { workspaceId: "ws", deviceId: "dev", status: "connected" },
        }),
      }),
    );
    await changed("");
    await settle(deviceRefreshDelayMs);
    assert.equal(refreshes, start + 4, "device and data change: one read");

    // Hidden: the browser stops animation frames, yet streamed events still
    // apply and announced changes are still read, so the tab title follows
    // the stream and the tab is current when it shows.
    visibility = "hidden";
    await act(() =>
      window.document.dispatchEvent(new window.Event("visibilitychange")),
    );
    await act(() =>
      source.onmessage({
        lastEventId: `ep-${++id}`,
        data: JSON.stringify({
          type: "agent_session_created",
          payload: session("s9", "running"),
        }),
      }),
    );
    await settle(hiddenFlushMs);
    assert.ok(
      shownData.agentSessions.some((item) => item.id === "s9"),
      "events apply while hidden",
    );
    await changed("ws");
    await settle();
    assert.equal(refreshes, start + 5, "an announced change is read hidden");
    visibility = "visible";
    await act(() =>
      window.document.dispatchEvent(new window.Event("visibilitychange")),
    );
    assert.equal(refreshes, start + 5, "nothing is due when it shows");
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
