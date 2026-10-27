import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

test("Toast bounds the stack, deduplicates StrictMode feedback, and retains Undo while its request fails or is busy", async (t) => {
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
    "HTMLInputElement",
    "HTMLButtonElement",
    "MutationObserver",
    "ResizeObserver",
    "CustomEvent",
    "Event",
    "MouseEvent",
    "PointerEvent",
    "KeyboardEvent",
    "NodeFilter",
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
  const { i18n } = await import("../src/i18n/index.ts");
  await i18n.changeLanguage("en");
  const { toast, ToastProvider, ToastFeedback } =
    await import("../src/components/ui/toast.tsx");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const ids = [];
  t.after(async () => {
    await act(async () => {
      ids.forEach(toast.dismiss);
      root.unmount();
      await tick();
    });
    await window.happyDOM.close();
    for (const [key, value] of previous)
      if (value) Object.defineProperty(globalThis, key, value);
      else delete globalThis[key];
  });
  await act(async () => {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(
          ToastProvider,
          null,
          createElement(ToastFeedback, { title: "Saved once" }),
        ),
      ),
    );
    await tick();
  });
  assert.equal(container.querySelectorAll(".fdy-toast").length, 1);
  await act(async () => {
    for (let index = 0; index < 4; index++)
      ids.push(toast({ title: `Result ${index}`, duration: Infinity }));
    await tick();
  });
  assert.equal(container.querySelectorAll(".fdy-toast").length, 3);
  assert.doesNotMatch(container.textContent, /Saved once|Result 0/);
  await act(() => ids.forEach(toast.dismiss));
  let calls = 0;
  let settle;
  let fail = true;
  let action;
  await act(async () => {
    action = toast({
      title: "Archived",
      action: {
        label: "Undo",
        onClick: () => {
          calls++;
          return new Promise((resolve, reject) => {
            settle = () =>
              fail ? reject(new Error("Synthetic failure")) : resolve();
          });
        },
      },
    });
    ids.push(action);
    await tick();
  });
  const undo = () =>
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Undo",
    );
  await act(async () => {
    undo().click();
    await tick();
    undo().click();
  });
  assert.equal(calls, 1);
  assert.equal(undo().disabled, true);
  await act(async () => {
    settle();
    await tick();
  });
  assert.equal(undo().disabled, false);
  assert.match(container.textContent, /Archived/);
  await act(() =>
    toast.update(action, {
      action: {
        label: "Undo",
        disabled: true,
        onClick: () => {
          calls++;
        },
      },
    }),
  );
  assert.equal(undo().disabled, true);
  await act(() =>
    toast.update(action, {
      action: {
        label: "Undo",
        onClick: async () => {
          fail = false;
          calls++;
        },
      },
    }),
  );
  await act(async () => {
    undo().click();
    await tick();
  });
  assert.equal(calls, 2);
  assert.equal(container.querySelectorAll(".fdy-toast").length, 0);
  await act(() => toast.update(action, { title: "Must not reopen" }));
  assert.equal(container.querySelectorAll(".fdy-toast").length, 0);

  let clipboardFailed = false;
  let written;
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text) => {
        if (clipboardFailed) throw new Error("Denied");
        written = text;
      },
    },
  });
  const { CopyButton } = await import("../src/components/ui/copy-button.tsx");
  await act(() =>
    root.render(
      createElement(
        ToastProvider,
        null,
        createElement(CopyButton, {
          text: "synthetic text",
          label: "Copy text",
          copiedLabel: "Copied text",
        }),
      ),
    ),
  );
  await act(async () => {
    container.querySelector("button").click();
    await tick();
  });
  assert.equal(written, "synthetic text");
  assert.equal(
    container.querySelectorAll('.fdy-toast[data-tone="success"]').length,
    1,
  );
  clipboardFailed = true;
  await act(async () => {
    container.querySelector("button").click();
    await tick();
  });
  assert.match(
    container.querySelector('.fdy-toast[data-tone="error"]').textContent,
    /Could not copy to clipboard/,
  );

  const { useResourceAction } =
    await import("../src/features/resources/resource-action.ts");
  let actionController;
  let finishResource;
  function ResourceHarness() {
    actionController = useResourceAction();
    return null;
  }
  await act(() =>
    root.render(
      createElement(ToastProvider, null, createElement(ResourceHarness)),
    ),
  );
  let resourceRequest;
  await act(() => {
    resourceRequest = actionController.run(
      "release",
      () =>
        new Promise((resolve) => {
          finishResource = resolve;
        }),
    );
  });
  await act(() => root.render(createElement(ToastProvider, null, null)));
  await act(async () => {
    finishResource("Released after leaving the page");
    await resourceRequest;
    await tick();
  });
  assert.match(
    container.querySelector(".fdy-toast-viewport").textContent,
    /Released after leaving the page/,
  );
});
