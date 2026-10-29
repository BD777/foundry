import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);

test("ArrowDown in the slash menu moves the highlight and key-up does not reset it", async () => {
  const window = new Window();
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
    "HTMLTextAreaElement",
    "HTMLButtonElement",
    "MutationObserver",
    "ResizeObserver",
    "Event",
    "KeyboardEvent",
    "MouseEvent",
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
  const { ComposerInput } =
    await import("../src/components/ui/message-composer.tsx");
  const { createRoot } = await import("react-dom/client");
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  try {
    const value = "/zsp";
    await act(() =>
      root.render(
        createElement(ComposerInput, {
          value,
          onChange() {},
          onSubmit() {},
          slashItems: [
            { value: "zspread-alpha" },
            { value: "zspread-beta" },
            { value: "zspread-gamma" },
          ],
        }),
      ),
    );
    const textarea = container.querySelector("textarea");
    textarea.setSelectionRange(value.length, value.length);
    const selected = () =>
      [...container.querySelectorAll("[role=option]")].findIndex(
        (option) => option.getAttribute("aria-selected") === "true",
      );
    await act(() =>
      textarea.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.equal(selected(), 0);
    for (const expected of [1, 2, 0]) {
      for (const type of ["keydown", "keyup"])
        await act(() =>
          textarea.dispatchEvent(
            new window.KeyboardEvent(type, {
              key: "ArrowDown",
              bubbles: true,
              cancelable: true,
            }),
          ),
        );
      assert.equal(selected(), expected, `after ArrowDown → ${expected}`);
    }
    await act(() =>
      textarea.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "ArrowUp",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await act(() =>
      textarea.dispatchEvent(
        new window.KeyboardEvent("keyup", { key: "ArrowUp", bubbles: true }),
      ),
    );
    assert.equal(selected(), 2, "ArrowUp wraps to the last item and stays");
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await window.happyDOM.close();
  }
});
