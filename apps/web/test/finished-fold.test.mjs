import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
register("./bundler-resolve.mjs", import.meta.url);

/** Renders into a happy-dom document; `body` runs with the container. */
async function withDom(render, body) {
  const window = new Window();
  const previous = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of ["Node", "Element", "HTMLElement", "HTMLButtonElement"])
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
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(await render(container)));
    await body(container, root);
    await act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    await window.happyDOM.close();
  }
}

test("the shared finished fold starts closed and opens its rows", async () => {
  const { FinishedFold, finishedFoldLabel } =
    await import("../src/components/finished-fold.tsx");
  const label = finishedFoldLabel("2 finished", "1 failed");
  assert.equal(label, "2 finished · 1 failed");
  const fold = (memoryKey) =>
    createElement(
      FinishedFold,
      { label, memoryKey },
      createElement("p", null, "Agent c1"),
      createElement("p", null, "Agent f1"),
    );
  await withDom(
    () => fold(),
    async (container) => {
      const button = () => container.querySelector("button");
      assert.equal(button().textContent, "2 finished · 1 failed");
      assert.equal(button().getAttribute("aria-expanded"), "false");
      assert.equal(container.querySelectorAll("p").length, 0);

      await act(async () => button().click());
      assert.equal(button().getAttribute("aria-expanded"), "true");
      const panel = container.ownerDocument.getElementById(
        button().getAttribute("aria-controls"),
      );
      assert.deepEqual(
        [...panel.querySelectorAll("p")].map((row) => row.textContent),
        ["Agent c1", "Agent f1"],
      );

      await act(async () => button().click());
      assert.equal(button().getAttribute("aria-expanded"), "false");
      assert.equal(button().getAttribute("aria-controls"), null);
    },
  );
});

test("a fold's open state is remembered per memoryKey", async () => {
  const { FinishedFold } = await import("../src/components/finished-fold.tsx");
  const fold = (memoryKey) =>
    createElement(FinishedFold, { label: "1 finished", memoryKey }, "row");
  await withDom(
    () => fold("shared-fold-test"),
    async (container, root) => {
      await act(async () => container.querySelector("button").click());
      await act(async () =>
        root.render(
          createElement(
            FinishedFold,
            { label: "2 finished", memoryKey: "other" },
            "row",
          ),
        ),
      );
      assert.equal(
        container.querySelector("button").getAttribute("aria-expanded"),
        "false",
      );
      await act(async () =>
        root.render(
          createElement(
            FinishedFold,
            { label: "1 finished", memoryKey: "shared-fold-test" },
            "row",
          ),
        ),
      );
      assert.equal(
        container.querySelector("button").getAttribute("aria-expanded"),
        "true",
      );
    },
  );
});
