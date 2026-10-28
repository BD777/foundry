import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

async function withDom(t) {
  const window = new Window({ url: "http://foundry.test/" });
  const previous = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of [
    "Node",
    "Element",
    "HTMLElement",
    "HTMLButtonElement",
    "MutationObserver",
    "ResizeObserver",
    "CustomEvent",
    "Event",
    "MouseEvent",
    "PointerEvent",
    "KeyboardEvent",
    "DOMRect",
    "DocumentFragment",
  ])
    globals[key] = window[key];
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { container, root };
}

const unreachable = {
  id: "unreachable",
  tone: "warning",
  label: "Reconnecting…",
  title: "Can't reach the Foundry server · retrying",
};
const update = {
  id: "new-build",
  tone: "info",
  label: "Update",
  title: "A new version of Foundry is available",
};

test("StatusIndicator ranks conditions by severity and keeps one live region mounted", async (t) => {
  const { container, root } = await withDom(t);
  const { i18n } = await import("../src/i18n/index.ts");
  await i18n.changeLanguage("en");
  const { StatusIndicator, rankStatusItems } =
    await import("../src/components/ui/status-indicator.tsx");

  assert.deepEqual(
    rankStatusItems([
      update,
      { ...unreachable, tone: "progress", id: "loading" },
      unreachable,
    ]).map((item) => item.id),
    ["unreachable", "new-build", "loading"],
  );

  await act(() => root.render(createElement(StatusIndicator, { items: [] })));
  const live = container.querySelector('[role="status"]');
  assert.ok(live, "the live region exists before any condition");
  assert.equal(live.textContent, "");
  assert.equal(container.querySelector("button"), null);

  await act(() =>
    root.render(
      createElement(StatusIndicator, { items: [update, unreachable] }),
    ),
  );
  assert.equal(container.querySelector('[role="status"]'), live);
  assert.match(live.textContent, /^Can't reach the Foundry server/);
  const pill = container.querySelector("button");
  assert.equal(pill.dataset.tone, "warning");
  assert.equal(pill.textContent, "Reconnecting…");
  assert.match(
    pill.getAttribute("aria-label"),
    /^Can't reach the Foundry server · retrying · A new version of Foundry is available — show details$/,
  );
  assert.equal(pill.getAttribute("aria-haspopup"), "dialog");

  await act(() =>
    root.render(
      createElement(StatusIndicator, { items: [unreachable], iconOnly: true }),
    ),
  );
  assert.equal(container.querySelector("button").textContent, "");
  assert.ok(container.querySelector("button").getAttribute("aria-label"));

  await act(() => root.render(createElement(StatusIndicator, { items: [] })));
  assert.equal(container.querySelector("button"), null);
  assert.equal(live.textContent, "");
});

test("useSustained reports a condition only once it held for the grace period", async (t) => {
  const { container, root } = await withDom(t);
  const { useSustained } = await import("../src/app/app-notices.tsx");
  function Probe({ active }) {
    return createElement("i", null, String(useSustained(active, 40)));
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await act(() => root.render(createElement(Probe, { active: true })));
  assert.equal(container.textContent, "false");
  await act(() => wait(20));
  await act(() => root.render(createElement(Probe, { active: false })));
  await act(() => root.render(createElement(Probe, { active: true })));
  await act(() => wait(25));
  assert.equal(container.textContent, "false", "a break restarts the wait");
  await act(() => wait(30));
  assert.equal(container.textContent, "true");
  await act(() => root.render(createElement(Probe, { active: false })));
  assert.equal(container.textContent, "false", "it clears at once");
});
