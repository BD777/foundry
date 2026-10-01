import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

register("./bundler-resolve.mjs", import.meta.url);

test("directory context menu renames and requires explicit confirmation before deleting all sessions", async () => {
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
  const { ChatGroupSection } =
    await import("../src/features/chat/chat-group-section.tsx");
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let renames = 0;
  let deletions = 0;
  let finish;
  const props = {
    group: { id: "g", name: "Work", collapsed: true },
    editing: false,
    sessionCount: 7,
    onEdit: () => {
      renames++;
    },
    onRename: () => {},
    onToggle: () => {},
    onDelete: () => {
      deletions++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const text = (selector, label) =>
    [...window.document.querySelectorAll(selector)].find(
      (node) => node.textContent.trim() === label,
    );
  const openMenu = () =>
    act(() => {
      container.querySelector(".fdy-chat-group-header").dispatchEvent(
        new window.MouseEvent("contextmenu", {
          bubbles: true,
          button: 2,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
  try {
    await act(() => root.render(createElement(ChatGroupSection, props)));
    await openMenu();
    assert.deepEqual(
      [...window.document.querySelectorAll('[role="menuitem"]')].map((node) =>
        node.textContent.trim(),
      ),
      ["Rename", "Delete"],
    );
    await act(() => text('[role="menuitem"]', "Rename").click());
    assert.equal(renames, 1);
    await openMenu();
    await act(() => text('[role="menuitem"]', "Delete").click());
    assert.equal(deletions, 0);
    assert.match(
      window.document.querySelector('[role="dialog"]').textContent,
      /all 7 sessions/,
    );
    assert.equal(window.document.activeElement.textContent, "Cancel");
    await act(() => text("button", "Cancel").click());
    assert.equal(deletions, 0);
    await openMenu();
    await act(() => text('[role="menuitem"]', "Delete").click());
    await act(() => text("button", "Delete group and sessions").click());
    assert.equal(deletions, 1);
    assert.equal(text("button", "Deleting…").disabled, true);
    assert.equal(text("button", "Cancel").disabled, true);
    await act(async () => {
      finish();
    });
    assert.equal(window.document.querySelector('[role="dialog"]'), null);
    await act(() =>
      root.render(
        createElement(ChatGroupSection, { ...props, sessionCount: 0 }),
      ),
    );
    await openMenu();
    await act(() => text('[role="menuitem"]', "Delete").click());
    assert.equal(deletions, 2, "empty directories delete immediately");
    assert.equal(window.document.querySelector('[role="dialog"]'), null);
    await openMenu();
    assert.equal(text('[role="menuitem"]', "Delete").disabled, true);
    await act(() =>
      window.document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    await act(async () => {
      finish();
    });
    await act(() =>
      root.render(
        createElement(ChatGroupSection, {
          ...props,
          sessionCount: 0,
          onDelete: async () => {
            throw new Error("服务暂不可用");
          },
        }),
      ),
    );
    await openMenu();
    await act(async () => {
      text('[role="menuitem"]', "Delete").click();
    });
    assert.equal(window.document.querySelector('[role="dialog"]'), null);
    assert.match(
      window.document.querySelector('[role="alert"]').textContent,
      /服务暂不可用/,
    );
  } finally {
    await act(() => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
