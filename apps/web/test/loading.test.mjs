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

test("loading primitives: a labelled busy status, a skeleton with a hidden label, a busy Button", async (t) => {
  const { container, root } = await withDom(t);
  const { LoadingState, Skeleton } =
    await import("../src/components/ui/loading.tsx");
  const { Button } = await import("../src/components/ui/button.tsx");
  await act(() =>
    root.render(
      createElement(
        "div",
        null,
        createElement(LoadingState, { label: "Checking chats…" }),
        createElement(Skeleton, { label: "Loading groups…", rows: 3 }),
        createElement(Button, { busy: true }, "Saving…"),
      ),
    ),
  );
  const [state, skeleton] = container.querySelectorAll('[role="status"]');
  assert.equal(state.getAttribute("aria-busy"), "true");
  assert.equal(state.textContent, "Checking chats…");
  assert.ok(state.querySelector("svg.fdy-spinner[aria-hidden='true']"));
  assert.equal(skeleton.getAttribute("aria-busy"), "true");
  assert.equal(skeleton.textContent, "Loading groups…");
  assert.equal(skeleton.querySelectorAll(".fdy-skeleton-bar").length, 3);
  const button = container.querySelector("button");
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute("aria-busy"), "true");
  assert.equal(button.textContent, "Saving…");
  assert.ok(button.querySelector("svg.fdy-spinner"));
  await act(() => root.render(createElement(Button, null, "Save")));
  const idle = container.querySelector("button");
  assert.equal(idle.disabled, false);
  assert.equal(idle.hasAttribute("aria-busy"), false);
  assert.equal(idle.querySelector("svg"), null);
});

test("toasts keep away from a view's composer", async () => {
  const { toastPlacementForView } = await import("../src/app/navigation.ts");
  for (const view of ["chats", "assistant", "issue"])
    assert.equal(toastPlacementForView(view), "top", view);
  for (const view of ["issues", "devices", "skills", "account"])
    assert.equal(toastPlacementForView(view), "bottom", view);
});
