import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { closeRadixDialogs, flushRadixTimers } from "./radix-cleanup.mjs";
register("./bundler-resolve.mjs", import.meta.url);

async function renderInDom(element) {
  const window = new Window({ url: "https://foundry.test/chats" });
  let root;
  const previous = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    IntersectionObserver: window.IntersectionObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of [
    "Node",
    "Element",
    "HTMLElement",
    "HTMLButtonElement",
    "HTMLInputElement",
    "Event",
    "CustomEvent",
    "MouseEvent",
    "PointerEvent",
    "KeyboardEvent",
    "MutationObserver",
    "ResizeObserver",
    "NodeFilter",
  ])
    globals[key] = window[key];
  globals.getComputedStyle = window.getComputedStyle.bind(window);
  globals.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globals.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  try {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(element));
    return container.textContent;
  } finally {
    await closeRadixDialogs(window);
    if (root) await act(async () => root.unmount());
    await flushRadixTimers(window);
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    await window.happyDOM.close();
  }
}

const { AnnotatedText } =
  await import("../src/components/conversation/annotation-reference.tsx");
const { TurnSourceRow } =
  await import("../src/components/conversation/turn-source-row.tsx");
const { turnSource } =
  await import("../src/components/conversation/turn-source.ts");

const marker = ':codex-annotation{index="1" id="0418a499"}';

test("a child report's answer shows its annotation markers as references", async () => {
  const message = {
    id: "m1",
    role: "user",
    kind: "message",
    at: "2026-11-17T16:00:00Z",
    inputSource: {
      kind: "child_report",
      title: "ByteWork",
      status: "completed",
      response: `结论已确认 ${marker}\n\n- 第二项 ${marker}`,
    },
  };
  const text = await renderInDom(
    createElement(TurnSourceRow, { message, source: turnSource(message) }),
  );
  assert.doesNotMatch(text, /codex-annotation/);
  assert.match(text, /Annotation 1/);
});

test("a marker a helper wrapped in code shows as a reference, not as code", async () => {
  const message = {
    id: "m2",
    role: "user",
    kind: "message",
    at: "2026-11-17T16:00:00Z",
    inputSource: {
      kind: "child_report",
      title: "ByteWork",
      status: "completed",
      response: `按 \`${marker}\` 处理`,
    },
  };
  const text = await renderInDom(
    createElement(TurnSourceRow, { message, source: turnSource(message) }),
  );
  assert.doesNotMatch(text, /codex-annotation/);
  assert.match(text, /Annotation 1/);
});

test("a snippet or plain row shows its markers as references, never raw", async () => {
  const text = await renderInDom(
    createElement(AnnotatedText, { text: `已修复 ${marker}` }),
  );
  assert.equal(text, "已修复 Annotation 1");
});
