import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { register } from "node:module";

register("./bundler-resolve.mjs", import.meta.url);

async function withDom(
  t,
  url = "http://foundry.test/chats/parent?workspace=ws",
) {
  const window = new Window({ url });
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
    "HTMLAnchorElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "MutationObserver",
    "NodeFilter",
    "ResizeObserver",
    "CustomEvent",
    "Event",
    "MouseEvent",
    "PointerEvent",
    "KeyboardEvent",
    "PopStateEvent",
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
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  });
  return { container, root, window };
}

test("a chat row names its waiting children instead of only changing colour", async (t) => {
  const { container, root } = await withDom(t);
  const { i18n } = await import("../src/i18n/index.ts");
  await i18n.changeLanguage("en");
  const { ChatListRow } =
    await import("../src/features/chat/list/chat-list-row.tsx");

  await act(() =>
    root.render(
      createElement(ChatListRow, {
        chat: {
          id: "parent",
          title: "Coordinate the release",
          unread: false,
          status: "processing",
          waitingChildCount: 2,
          updateTime: {
            dateTime: "2026-11-10T12:00:00Z",
            label: "19:40",
            title: "Last updated",
          },
          foundrySessionId: "parent",
          onSelect() {},
          onRename: async () => {},
          onAutoRename: async () => {},
          onMarkUnread() {},
          onNotify() {},
        },
        groupMenu: {
          groups: [],
          disabled: false,
          onMove() {},
          onNewGroup() {},
        },
      }),
    ),
  );

  const state = container.querySelector(".fdy-waiting-children");
  assert.ok(state);
  assert.equal(state.textContent, "2");
  assert.equal(state.getAttribute("aria-label"), "Waiting on 2 sub-sessions");
  assert.equal(state.getAttribute("title"), "Waiting on 2 sub-sessions");
  assert.ok(state.querySelector("svg"), "the state carries an icon");
  assert.match(state.className, /fdy-badge-xs/);
  assert.equal(
    container.querySelector(".fdy-chat-row strong")?.textContent,
    "Coordinate the release",
  );
  assert.equal(container.querySelector(".fdy-chat-row time"), null);
});

test("the open-chat capsule lists child sessions and opens one in-app", async (t) => {
  const { container, root, window } = await withDom(t);
  const { i18n } = await import("../src/i18n/index.ts");
  await i18n.changeLanguage("en");
  const { ChatThreadHeader } =
    await import("../src/features/chat/chat-thread-header.tsx");

  await act(() =>
    root.render(
      createElement(ChatThreadHeader, {
        contextOpen: false,
        foldedTurns: 0,
        onlyMine: false,
        onOnlyMineChange() {},
        onBack() {},
        onToggleContext() {},
        title: "发布协调",
        waitingChildCount: 2,
        waitingChildren: [
          {
            id: "child_docs",
            selected: true,
            status: "running",
            title: "更新发布说明",
            workspaceId: "ws",
          },
          {
            id: "child_tests",
            status: "completed",
            title: "检查回归测试",
            workspaceId: "ws",
          },
        ],
        workspaceId: "ws",
      }),
    ),
  );

  assert.equal(
    container.querySelector(".fdy-waiting-children-wide")?.textContent,
    "Waiting on 2",
  );
  await act(async () => i18n.changeLanguage("zh-CN"));
  assert.equal(
    container.querySelector(".fdy-waiting-children-wide")?.textContent,
    "等待 2 个子会话",
  );
  const trigger = container.querySelector(
    'button[aria-label="等待 2 个子会话"]',
  );
  assert.ok(trigger);
  await act(async () => {
    trigger.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const child = [...document.querySelectorAll("a")].find((link) =>
    link.textContent.includes("更新发布说明"),
  );
  assert.ok(child);
  assert.match(child.textContent, /运行中/);
  assert.equal(child.getAttribute("data-selected"), "true");
  assert.equal(child.getAttribute("aria-current"), "page");
  const chevron = child.querySelector(".fdy-waiting-child-chevron");
  assert.ok(chevron);
  assert.match(chevron.getAttribute("class"), /flex-none/);
  assert.match(
    child.getAttribute("class"),
    /grid-cols-\[minmax\(0,1fr\)_auto_auto\]/,
  );
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.match(dialog.className, /bg-panel/);
  assert.doesNotMatch(dialog.className, /bg-floating/);
  await act(() => child.click());
  assert.equal(window.location.pathname, "/chats/child_docs");
  assert.equal(window.location.search, "?workspace=ws");
});
