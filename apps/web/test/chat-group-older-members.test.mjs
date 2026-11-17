import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

register("./bundler-resolve.mjs", import.meta.url);

test("a folder shows its older members as a quiet row that reads one page", async () => {
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
    await import("../src/features/chat/list/chat-group-section.tsx");
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const button = (label) =>
    [...window.document.querySelectorAll("button")].find(
      (node) => node.textContent.trim() === label,
    );
  let loads = 0;
  const props = {
    group: { id: "g", name: "Work", collapsed: false },
    editing: false,
    sessionCount: 7,
    onEdit: () => {},
    onRename: () => {},
    onToggle: () => {},
    onDelete: async () => {},
  };
  try {
    await act(() =>
      root.render(
        createElement(
          ChatGroupSection,
          { ...props, olderCount: 9, onLoadOlder: () => loads++ },
          createElement("p", null, "one shown chat"),
        ),
      ),
    );
    const older = button("9 older chats");
    assert.equal(older.getAttribute("aria-expanded"), "false");
    assert.equal(older.tabIndex, 0);
    await act(() => older.click());
    assert.equal(loads, 1);
    await act(() =>
      root.render(
        createElement(
          ChatGroupSection,
          {
            ...props,
            olderCount: 9,
            olderLoading: true,
            olderExpanded: true,
            onLoadOlder: () => {},
          },
          createElement("p", null, "one shown chat"),
        ),
      ),
    );
    assert.equal(button("Loading older chats…").disabled, true);
    assert.equal(
      button("Loading older chats…").getAttribute("aria-expanded"),
      "true",
    );
    await act(() =>
      root.render(
        createElement(
          ChatGroupSection,
          { ...props, olderCount: 0 },
          createElement("p", null, "one shown chat"),
        ),
      ),
    );
    assert.equal(
      [...window.document.querySelectorAll("button")].some((node) =>
        /older chats?/.test(node.textContent),
      ),
      false,
    );
  } finally {
    await act(() => root.unmount());
    container.remove();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  }
});
