import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement, StrictMode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";

register("./bundler-resolve.mjs", import.meta.url);
const { useChatTurnNavigation } =
  await import("../src/features/chat/use-chat-turn-navigation.ts");
const { buildChatTurnAnchors } =
  await import("../src/features/chat/chat-turn-navigation.ts");

test("virtualizer notifications sample settled geometry once per frame without commit feedback", async () => {
  const window = new Window();
  const previousGlobals = new Map();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    ResizeObserver: window.ResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const frames = new Map();
  let frameId = 0;
  window.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  const flushFrame = async () => {
    const pending = [...frames.values()];
    frames.clear();
    await act(() => pending.forEach((callback) => callback(0)));
  };
  const metrics = { clientHeight: 400, scrollHeight: 400, scrollTop: 0 };
  const viewport = window.document.createElement("div");
  for (const key of Object.keys(metrics)) {
    Object.defineProperty(viewport, key, { get: () => metrics[key] });
  }
  let messages = [
    { id: "q1", role: "user", text: "First" },
    { id: "a1", role: "bot", text: "Long history" },
    { id: "q2", role: "user", text: "Second" },
  ];
  let anchors = buildChatTurnAnchors(messages);
  let controller;
  let commits = 0;
  let selectedViewport = viewport;
  let threadKey = "old-session";
  const items = [
    { index: 0, offset: 0 },
    { index: 1, offset: 100 },
    { index: 2, offset: 1800 },
  ];
  const readHistory = () => {};
  const virtuosoRef = { current: null };
  function Harness() {
    controller = useChatTurnNavigation({
      anchors,
      messageCount: messages.length,
      readHistory,
      threadKey,
      viewport: selectedViewport,
      virtuosoRef,
    });
    useLayoutEffect(() => {
      commits += 1;
    });
    return null;
  }
  const root = createRoot(window.document.createElement("div"));
  const render = () =>
    act(() =>
      root.render(createElement(StrictMode, null, createElement(Harness))),
    );
  try {
    await render();
    await flushFrame();
    const beforePublish = commits;
    await act(() => {
      // During a virtualizer commit, dimensions can temporarily collapse.
      // Only the final geometry may affect the navigation UI.
      for (let index = 0; index < 100; index += 1) {
        metrics.scrollHeight = index % 2 ? 2000 : 400;
        controller.onItemsRendered(items);
        controller.onContentResized();
      }
    });
    assert.equal(
      commits,
      beforePublish,
      "virtualizer callbacks must not synchronously commit parent state",
    );
    assert.equal(
      frames.size,
      1,
      "all geometry notifications share one pending frame",
    );
    await flushFrame();
    assert.equal(controller.enabled, true);
    assert.equal(controller.activeIndex, 0);

    // Appending a turn while reading history must not first select the last turn.
    messages = [...messages, { id: "q3", role: "user", text: "Continue" }];
    anchors = buildChatTurnAnchors(messages);
    await render();
    assert.equal(controller.activeIndex, 0);
    await flushFrame();
    assert.equal(controller.activeIndex, 0);
    metrics.scrollTop = 1600;
    await act(() => controller.onContentResized());
    await flushFrame();
    assert.equal(
      controller.activeIndex,
      2,
      "following the bottom selects the new turn",
    );

    // An unchanged snapshot must converge even if a virtualizer republishes.
    await act(() => controller.onItemsRendered(items));
    await flushFrame();
    const settledCommits = commits;
    for (let index = 0; index < 5; index += 1) {
      await act(() => controller.onItemsRendered(items));
      await flushFrame();
    }
    assert.equal(commits, settledCommits);

    await act(() => controller.onItemsRendered(items));
    selectedViewport = null;
    threadKey = "next-session";
    await render();
    await act(() => root.unmount());
    assert.equal(
      frames.size,
      0,
      "detach and unmount cancel pending measurements, including a null viewport",
    );
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await window.happyDOM.close();
  }
});
