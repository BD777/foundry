import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);

const window = new Window();
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "MutationObserver",
  "ResizeObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "NodeFilter",
  "DOMRect",
])
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: window[key],
  });
Object.defineProperty(globalThis, "getComputedStyle", {
  configurable: true,
  value: window.getComputedStyle.bind(window),
});
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: window.requestAnimationFrame.bind(window),
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: window.cancelAnimationFrame.bind(window),
});
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

const { createRoot } = await import("react-dom/client");
const { ProcessDisclosure } =
  await import("../src/components/conversation/process-disclosure.tsx");
const { i18n } = await import("../src/i18n/index.ts");

test("a Session failed row expands with the shared disclosure control", async () => {
  await i18n.changeLanguage("en");
  const detail =
    "API Error: Request rejected (429) · upstream account quota usage limit has been reached; an account becomes available again at 07:42 UTC";
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(ProcessDisclosure, {
          items: [{ id: "failure", title: "Session failed", detail }],
          text: "Processed",
          title: "Processed",
        }),
      ),
    );
    const group = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Processed"),
    );
    assert.ok(group);
    await act(async () => group.click());

    const row = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Session failed"),
    );
    assert.ok(row);
    assert.equal(row.tagName, "BUTTON");
    assert.equal(row.getAttribute("aria-expanded"), "false");
    await act(async () => row.click());
    assert.equal(row.getAttribute("aria-expanded"), "true");
    const expanded = container.querySelector(".select-text");
    assert.ok(expanded);
    assert.match(
      expanded.textContent ?? "",
      /upstream account quota usage limit/,
    );

    await act(async () => row.click());
    assert.equal(row.getAttribute("aria-expanded"), "false");
    assert.equal(container.querySelector(".select-text"), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    await i18n.changeLanguage("en");
  }
});
