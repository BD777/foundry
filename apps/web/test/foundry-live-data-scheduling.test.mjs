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

test("an SSE frame and synchronous hydration commit one consistent projection", async () => {
  const window = new Window();
  let source;
  let closed = 0;
  let refreshes = 0;
  class EventSource {
    constructor() {
      source = this;
    }
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
  let hydrate;
  function Harness() {
    const [data, setData] = useState({
      workspace: { id: "ws_1", contextSummary: "summary" },
      agentSessions: [
        { id: "sess_1", workspaceId: "ws_1", status: "running", events: [] },
      ],
    });
    useFoundryLiveData({
      enabled: true,
      activeSession: true,
      onRefresh: () => {
        refreshes++;
      },
      setData,
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
      "connection open repairs the persisted snapshot",
    );
    await act(() => source.onerror());
    await act(() => source.onopen());
    assert.equal(
      refreshes,
      3,
      "reconnection must refresh even if the previous snapshot was cached",
    );
    snapshots.length = 0;
    const emit = (index) =>
      source.onmessage({
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
    emit(10);
    assert.equal(frames.size, 1);
    await act(() => root.unmount());
    assert.equal(frames.size, 0);
    assert.equal(
      closed,
      2,
      "StrictMode replay and final unmount each close their SSE connection",
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
