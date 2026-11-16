import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({ url: "https://foundry.example/assistant" });
for (const key of [
  "window",
  "document",
  "navigator",
  "localStorage",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "HTMLDivElement",
  "MutationObserver",
  "ResizeObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "FocusEvent",
  "PopStateEvent",
  "NodeFilter",
  "DOMRect",
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === "window" ? window : window[key],
  });
}
Object.assign(globalThis, {
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { i18n } = await import("../src/i18n/index.ts");
await i18n.changeLanguage("en");
const { NeedsYouSection } =
  await import("../src/features/personal-agent/assistant-side-card.tsx");
const { sideSummary } =
  await import("../src/features/personal-agent/assistant-model.ts");

async function render(component, props) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(component, props)));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("needs-you is one count row to the Needs you page, in a new tab", async () => {
  const page = await render(NeedsYouSection, { count: 3 });
  const link = page.container.querySelector("a");
  assert.ok(link);
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.textContent.trim(), "Needs you3");
  assert.equal(page.container.querySelectorAll("a").length, 1);
  await page.unmount();
});

test("needs-you with nothing waiting is not in the card", async () => {
  const page = await render(NeedsYouSection, { count: 0 });
  assert.equal(page.container.textContent, "");
  await page.unmount();
});

test("the narrow summary names only the sections that hold something", () => {
  const t = i18n.getFixedT("zh-CN", "personalAgent");
  const parts = sideSummary({ needsYou: 4, list: 4, tasks: 0 });
  assert.equal(
    parts.map((part) => t(part.key, { count: part.count })).join(" · "),
    "等你处理 4 · 事项 4",
  );
  assert.deepEqual(sideSummary({ needsYou: 0, list: 0, tasks: 0 }), []);
});
