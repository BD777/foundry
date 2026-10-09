import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
register("./bundler-resolve.mjs", import.meta.url);

async function renderMarkdown(props, text) {
  const window = new Window();
  const previous = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of ["Node", "Element", "HTMLElement", "Event", "MouseEvent"])
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
    const { MarkdownContent } =
      await import("../src/components/conversation/chat-message-content.tsx");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(createElement(MarkdownContent, props, text)),
    );
    const html = container.innerHTML;
    await act(async () => root.unmount());
    return html;
  } finally {
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    await window.happyDOM.close();
  }
}

test("a person's message keeps its line breaks and literal list markers", async () => {
  const html = await renderMarkdown(
    { typedText: true },
    "我试了：\n1. 刷新页面\n2. 重启 worker",
  );
  assert.equal(html.match(/<br>/g)?.length, 2);
  assert.match(html, /1\. 刷新页面/);
  assert.doesNotMatch(html, /<ol/);
});

test("an agent answer keeps Markdown soft breaks and GFM task lists", async () => {
  const html = await renderMarkdown(
    {},
    "line one\nline two\n\n- [x] done\n- [ ] todo",
  );
  assert.doesNotMatch(html, /<br>/);
  assert.match(html, /<ul class="contains-task-list">/);
  assert.equal(html.match(/<li class="task-list-item">/g)?.length, 2);
});
