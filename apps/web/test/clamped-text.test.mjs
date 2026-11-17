import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({ url: "https://foundry.example/project" });
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLButtonElement",
  "MutationObserver",
  "ResizeObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === "window" ? window : window[key],
  });
}
Object.assign(globalThis, {
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
// happy-dom lays nothing out: a line box is 20px, and text longer than two
// lines reports the height it would need.
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get: () => 20,
});
Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
  configurable: true,
  get() {
    return (this.textContent ?? "").length > 40 ? 60 : 20;
  },
});

const { createRoot } = await import("react-dom/client");
const { i18n } = await import("../src/i18n/index.ts");
await i18n.changeLanguage("en");
const { ClampedText } = await import("../src/components/ui/clamped-text.tsx");

async function render(node) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return { container, root };
}

const text = (container) => container.querySelector("p");
const toggle = (container) => container.querySelector("button");

test("short text shows whole, with no toggle", async () => {
  const { container, root } = await render(
    createElement(ClampedText, null, "One line."),
  );
  assert.equal(text(container).textContent, "One line.");
  assert.equal(toggle(container), null);
  await act(async () => root.unmount());
});

test("long text clamps, toggles open with aria-expanded, then closed", async () => {
  const long =
    "The intro, the first bullet and the escalation guidance all repeat what " +
    "the other section already says, so this review suggests one merged bullet.";
  const { container, root } = await render(
    createElement(
      ClampedText,
      { clamp: 2, moreLabel: "展开", lessLabel: "收起" },
      long,
    ),
  );
  assert.ok(text(container).className.includes("line-clamp-2"));
  const button = toggle(container);
  assert.equal(button.textContent, "展开");
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(
    button.getAttribute("aria-controls"),
    text(container).getAttribute("id"),
  );

  await act(async () => button.click());
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(button.textContent, "收起");
  assert.ok(!text(container).className.includes("line-clamp-2"));
  assert.equal(text(container).textContent, long);

  await act(async () => button.click());
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.ok(text(container).className.includes("line-clamp-2"));
  await act(async () => root.unmount());
});

test("short text after a long one loses its toggle on re-measure", async () => {
  const { container, root } = await render(
    createElement(
      ClampedText,
      null,
      "This text is long enough to need the space of several lines in its box.",
    ),
  );
  assert.ok(toggle(container));
  await act(async () =>
    root.render(createElement(ClampedText, null, "Short.")),
  );
  assert.equal(toggle(container), null);
  await act(async () => root.unmount());
});
