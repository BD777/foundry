import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import {
  act,
  createElement,
  StrictMode,
  useLayoutEffect,
  useState,
} from "react";
import { createRoot } from "react-dom/client";

register("./bundler-resolve.mjs", import.meta.url);
const { useFoundryLiveData } =
  await import("../src/app/use-foundry-live-data.ts");
const { createStreamTouchLedger } =
  await import("../src/app/stream-touches.ts");

test("an SSE frame and synchronous hydration commit one consistent projection", async () => {
  const window = new Window();
  let source;
  let closed = 0;
  let refreshes = 0;
  class EventSource {
    constructor() {
      source = this;
    }
    addEventListener() {}
    close() {
      closed += 1;
    }
  }
  const previous = new Map();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    EventSource,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  const frames = new Map();
  let frameId = 0;
  window.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  const snapshots = [];
  const touches = createStreamTouchLedger();
  let hydrate;
  function Harness() {
    const [data, setData] = useState({
      workspace: { id: "ws_1", contextSummary: "summary" },
      agentSessions: [
        { id: "sess_1", workspaceId: "ws_1", status: "running", events: [] },
      ],
    });
    useFoundryLiveData({
      activeSession: true,
      devices: [],
      enabled: true,
      onRefresh: () => {
        refreshes++;
      },
      setData,
      touches,
      workspaceId: "ws_1",
    });
    hydrate = () =>
      setData((current) => ({
        ...current,
        workspace: { ...current.workspace, contextSummary: "hydrated" },
      }));
    useLayoutEffect(() => {
      snapshots.push({
        events: data.agentSessions[0].events.length,
        hydrated: data.workspace.contextSummary === "hydrated",
      });
    }, [data]);
    return null;
  }
  const root = createRoot(window.document.createElement("div"));
  try {
    await act(() =>
      root.render(createElement(StrictMode, null, createElement(Harness))),
    );
    await act(() => source.onopen());
    assert.equal(
      refreshes,
      1,
      "the first connection has nowhere to resume from: the snapshot is read",
    );
    snapshots.length = 0;
    const emit = (index) =>
      source.onmessage({
        lastEventId: `epoch-${index + 1}`,
        data: JSON.stringify({
          type: "agent_session_event",
          payload: {
            id: `evt_${index}`,
            sessionId: "sess_1",
            at: "2026-09-01T00:00:00Z",
            label: "Tool",
            detail: `Output ${index}`,
            level: "info",
          },
        }),
      });
    for (let i = 0; i < 10; i++) emit(i);
    assert.equal(
      frames.size,
      1,
      "stream bursts are still batched into one frame",
    );
    assert.equal(
      snapshots.length,
      0,
      "transport receipt alone does not render",
    );
    await act(() => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
      hydrate();
    });
    assert.deepEqual(
      snapshots,
      [{ events: 10, hydrated: true }],
      "hydration must not overtake a deferred stream projection and force reducer rebasing",
    );
    await act(() => source.onerror());
    await act(() => source.onopen());
    assert.equal(
      refreshes,
      1,
      "a reconnect resumes after the last id (the server replays): no read",
    );
    await act(() =>
      source.onmessage({
        lastEventId: "epoch-10",
        data: JSON.stringify({
          type: "resync",
          payload: { reason: "expired" },
        }),
      }),
    );
    assert.equal(refreshes, 2, "a resync reads the snapshot again");
    emit(10);
    assert.equal(frames.size, 1);
    await act(() => root.unmount());
    assert.equal(frames.size, 0);
    assert.equal(closed, 0, "a remount could still reuse the connection");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(
      closed,
      1,
      "StrictMode replay shares one tab connection, closed once unused",
    );
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await window.happyDOM.close();
  }
});
