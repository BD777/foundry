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
      ["重命名", "删除"],
    );
    await act(() => text('[role="menuitem"]', "重命名").click());
    assert.equal(renames, 1);
    await openMenu();
    await act(() => text('[role="menuitem"]', "删除").click());
    assert.equal(deletions, 0);
    assert.match(
      window.document.querySelector('[role="dialog"]').textContent,
      /全部 7 个 Session/,
    );
    assert.equal(window.document.activeElement.textContent, "取消");
    await act(() => text("button", "取消").click());
    assert.equal(deletions, 0);
    await openMenu();
    await act(() => text('[role="menuitem"]', "删除").click());
    await act(() => text("button", "删除目录及 Session").click());
    assert.equal(deletions, 1);
    assert.equal(text("button", "删除中…").disabled, true);
    assert.equal(text("button", "取消").disabled, true);
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
    await act(() => text('[role="menuitem"]', "删除").click());
    assert.equal(deletions, 2, "empty directories delete immediately");
    assert.equal(window.document.querySelector('[role="dialog"]'), null);
    await openMenu();
    assert.equal(text('[role="menuitem"]', "删除").disabled, true);
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
      text('[role="menuitem"]', "删除").click();
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
