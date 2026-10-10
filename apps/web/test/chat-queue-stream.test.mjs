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

test("queue: on page load the selected chat's queue is read once the stream opens; a read before a late open is repeated", async (t) => {
  const window = new Window();
  const previous = new Map();
  const reads = [];
  const fetch = async (url) => {
    const chatId = decodeURIComponent(
      String(url).match(/\/api\/chats\/([^/]+)\/queue$/)?.[1] ?? "",
    );
    assert.ok(chatId, `unexpected request ${url}`);
    reads.push(chatId);
    return new Response(
      JSON.stringify({ workspaceId: "ws", chatId, revision: 1, items: [] }),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    EventSource: FakeEventSource,
    fetch,
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
  const { foundryStreamOpenWaitMs } = await import("../src/api.ts");
  const { useChatQueue } =
    await import("../src/features/chat/use-chat-queue.ts");
  function Harness({ chatId }) {
    useChatQueue({ workspaceId: "ws", chatId, runSettings: () => ({}) });
    return null;
  }
  const root = createRoot(window.document.createElement("div"));
  const settle = () =>
    act(async () => {
      for (let index = 0; index < 3; index++)
        await new Promise((resolve) => setImmediate(resolve));
    });
  try {
    await act(() => root.render(createElement(Harness, { chatId: "c1" })));
    await settle();
    assert.deepEqual(reads, [], "the read waits for the stream");
    const first = FakeEventSource.last;
    await act(() => first.onopen());
    await settle();
    assert.deepEqual(reads, ["c1"], "one read, after the stream opened");

    // A stream that opens late: the page reads without it, then once more.
    await act(() => first.onerror());
    await act(() => root.render(createElement(Harness, { chatId: "c2" })));
    await act(() => t.mock.timers.tick(foundryStreamOpenWaitMs));
    await settle();
    assert.deepEqual(reads, ["c1", "c2"], "read without waiting longer");
    await act(() => first.onopen());
    await settle();
    assert.deepEqual(
      reads,
      ["c1", "c2", "c2"],
      "events may have been missed: no id to resume from",
    );
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

test("queue: read once per chat shown; reconnects resume, only a resync reads again", async (t) => {
  const window = new Window();
  const previous = new Map();
  const reads = [];
  const fetch = async (url) => {
    const chatId = decodeURIComponent(
      String(url).match(/\/api\/chats\/([^/]+)\/queue$/)?.[1] ?? "",
    );
    assert.ok(chatId, `unexpected request ${url}`);
    reads.push(chatId);
    return new Response(
      JSON.stringify({ workspaceId: "ws", chatId, revision: 1, items: [] }),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    EventSource: FakeEventSource,
    fetch,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  const { subscribeFoundryEvents } = await import("../src/api.ts");
  const { useChatQueue } =
    await import("../src/features/chat/use-chat-queue.ts");
  // The app's own subscription has the tab's connection open already.
  const stopApp = subscribeFoundryEvents(() => {});
  const source = FakeEventSource.last;
  source.onopen();
  source.onmessage({
    lastEventId: "ep-1",
    data: JSON.stringify({
      type: "chat_titles_changed",
      payload: { workspaceId: "ws" },
    }),
  });
  function Harness({ chatId }) {
    useChatQueue({ workspaceId: "ws", chatId, runSettings: () => ({}) });
    return null;
  }
  const root = createRoot(window.document.createElement("div"));
  const settle = () =>
    act(async () => {
      for (let index = 0; index < 3; index++)
        await new Promise((resolve) => setImmediate(resolve));
    });
  try {
    await act(() => root.render(createElement(Harness, { chatId: "c1" })));
    await settle();
    assert.deepEqual(reads, ["c1"], "joining an open stream reads once");
    await act(() => root.render(createElement(Harness, { chatId: "c2" })));
    await settle();
    assert.deepEqual(reads, ["c1", "c2"], "another chat: its queue once");
    await act(() => root.render(createElement(Harness, { chatId: "c1" })));
    await settle();
    assert.deepEqual(reads, ["c1", "c2"], "shown again: read already");
    // A queue the stream carried needs no read either.
    await act(() =>
      source.onmessage({
        lastEventId: "ep-1a",
        data: JSON.stringify({
          type: "chat_queue_changed",
          payload: { workspaceId: "ws", chatId: "c3", revision: 4, items: [] },
        }),
      }),
    );
    await act(() => root.render(createElement(Harness, { chatId: "c3" })));
    await settle();
    assert.deepEqual(reads, ["c1", "c2"], "pushed: no read");
    await act(() => root.render(createElement(Harness, { chatId: "c2" })));
    await settle();
    await act(() => {
      source.onerror();
      source.onopen();
    });
    await settle();
    assert.deepEqual(reads, ["c1", "c2"], "a resumed reconnect reads nothing");
    await act(() =>
      source.onmessage({
        lastEventId: "ep-2",
        data: JSON.stringify({
          type: "resync",
          payload: { reason: "expired" },
        }),
      }),
    );
    await settle();
    assert.deepEqual(
      reads,
      ["c1", "c2", "c2"],
      "a resync reads the shown chat",
    );
    await act(() => root.render(createElement(Harness, { chatId: "c1" })));
    await settle();
    assert.deepEqual(
      reads,
      ["c1", "c2", "c2", "c1"],
      "another chat read before the resync is read when shown",
    );
    await act(() => root.render(createElement(Harness, { chatId: "c2" })));
    await settle();
    assert.equal(reads.length, 4, "the shown one stays current");
  } finally {
    await act(() => root.unmount());
    stopApp();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await window.happyDOM.close();
  }
});

test("queue: a chat of another workspace that changed while it was not shown is read when shown again", async (t) => {
  const window = new Window();
  const previous = new Map();
  const reads = [];
  // The server's queues: chats of ws_a and ws_b.
  const server = { a1: 1, b1: 1 };
  const fetch = async (url) => {
    const chatId = decodeURIComponent(
      String(url).match(/\/api\/chats\/([^/]+)\/queue$/)?.[1] ?? "",
    );
    assert.ok(chatId, `unexpected request ${url}`);
    reads.push(chatId);
    return new Response(
      JSON.stringify({
        workspaceId: `ws_${chatId[0]}`,
        chatId,
        revision: server[chatId],
        items: [],
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    EventSource: FakeEventSource,
    fetch,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  const { subscribeFoundryEvents } = await import("../src/api.ts");
  const { useChatQueue } =
    await import("../src/features/chat/use-chat-queue.ts");
  const stopApp = subscribeFoundryEvents(() => {});
  const source = FakeEventSource.last;
  source.onopen();
  let shown;
  function Harness({ workspaceId, chatId }) {
    shown = useChatQueue({ workspaceId, chatId, runSettings: () => ({}) });
    return null;
  }
  const root = createRoot(window.document.createElement("div"));
  const settle = () =>
    act(async () => {
      for (let index = 0; index < 3; index++)
        await new Promise((resolve) => setImmediate(resolve));
    });
  const show = async (workspaceId, chatId) => {
    await act(() =>
      root.render(createElement(Harness, { workspaceId, chatId })),
    );
    await settle();
  };
  try {
    await show("ws_b", "b1");
    await show("ws_a", "a1");
    assert.deepEqual(reads, ["b1", "a1"]);
    // While ws_a shows, b1's queue changes.
    server.b1 = 5;
    await act(() =>
      source.onmessage({
        lastEventId: "ep-b1",
        data: JSON.stringify({
          type: "chat_queue_changed",
          payload: {
            workspaceId: "ws_b",
            chatId: "b1",
            revision: 5,
            items: [{ id: "q1", text: "queued", state: "queued", revision: 5 }],
          },
        }),
      }),
    );
    await show("ws_b", "b1");
    assert.deepEqual(reads, ["b1", "a1", "b1"], "b1 is read again");
    await show("ws_a", "a1");
    assert.deepEqual(reads, ["b1", "a1", "b1"], "a1 did not change: no read");
  } finally {
    await act(() => root.unmount());
    stopApp();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await window.happyDOM.close();
  }
});
