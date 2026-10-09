import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
register("./bundler-resolve.mjs", import.meta.url);

async function renderMarkdown(props, text, inspect) {
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
    await inspect?.(container);
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

test("relative links open verified files or stay text; unsafe links stay blocked", async () => {
  const opened = [];
  const reference = {
    text: "docs/plan.md",
    path: "docs/plan.md",
    kind: "file",
  };
  const html = await renderMarkdown(
    { fileReferences: [reference], onOpenFileReference: (r) => opened.push(r) },
    "See [plan](docs/plan.md), [notes](./notes/todo.md), [site](https://example.com/a), [route](/chats/x) and [bad](javascript:alert(1)).",
    async (container) => {
      const button = container.querySelector(".fdy-chat-file-reference");
      assert.equal(button?.textContent, "plan");
      await act(async () => button.click());
    },
  );
  assert.deepEqual(opened, [reference]);
  assert.match(html, /<span title="\.\/notes\/todo\.md">notes<\/span>/);
  assert.doesNotMatch(html, /href="[^"]*(docs\/plan|notes\/todo)/);
  assert.match(
    html,
    /<a target="_blank"[^>]*href="https:\/\/example\.com\/a">site/,
  );
  assert.match(html, /<a target="_blank"[^>]*href="\/chats\/x">route/);
  assert.doesNotMatch(html, /javascript:/);
  assert.equal(html.match(/\[blocked\]/g)?.length, 1);
});

test("while an answer streams, a relative link is text titled with its target", async () => {
  const html = await renderMarkdown({}, "Read [the plan](docs/plan.md).");
  assert.match(html, /<span title="docs\/plan\.md">the plan<\/span>/);
  assert.doesNotMatch(html, /\[blocked\]/);
});
