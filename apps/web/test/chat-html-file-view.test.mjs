import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

const window = new Window();
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLIFrameElement",
  "MutationObserver",
  "ResizeObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "DOMRect",
])
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === "window" ? window : window[key],
  });
Object.assign(globalThis, {
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
await import("../src/i18n/index.ts");
const { HtmlFileView, htmlExtensions } =
  await import("../src/features/chat/chat-detail-files.tsx");

test("HtmlFileView renders sandboxed iframe preview by default and switches to code view", async () => {
  assert.equal(htmlExtensions.has("html"), true);
  assert.equal(htmlExtensions.has("htm"), true);

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  const sampleHtml = "<h1>Hello world</h1><p>Test</p>";

  await act(async () =>
    root.render(
      createElement(HtmlFileView, {
        content: sampleHtml,
        path: "test/review.html",
      }),
    ),
  );

  const iframe = container.querySelector("iframe");
  assert.ok(iframe, "iframe should be rendered by default");
  assert.equal(iframe.getAttribute("srcDoc"), sampleHtml);
  assert.equal(iframe.getAttribute("sandbox"), "allow-scripts allow-forms allow-popups");

  // Toggle to code view
  const buttons = [...container.querySelectorAll("button")];
  const codeToggle = buttons.find((b) => b.getAttribute("value") === "code" || b.textContent?.includes("源码") || b.textContent?.includes("Code"));
  assert.ok(codeToggle, "Code toggle should exist");

  await act(async () => codeToggle.click());

  assert.equal(container.querySelector("iframe"), null, "iframe should not exist in code view");
  const codeBlock = container.querySelector("code");
  assert.ok(codeBlock, "code element should exist in code view");
  assert.equal(codeBlock.textContent, sampleHtml);
});
