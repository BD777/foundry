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

test("the open-chat capsule reveals the same child sessions in Agents", async (t) => {
  const { container, root, window } = await withDom(t);
  const { i18n } = await import("../src/i18n/index.ts");
  await i18n.changeLanguage("en");
  const { ChatThreadHeader } =
    await import("../src/features/chat/chat-thread-header.tsx");
  const { ChatContextCard } =
    await import("../src/features/chat/context/chat-context-card.tsx");
  let reveals = 0;
  const work = {
    control() {},
    error: undefined,
    list: {
      barrier: false,
      coverage: {
        hostSchedules: "not_observed",
        processes: "not_observed",
      },
      items: [
        {
          allowedActions: ["stop"],
          createdAt: "2026-11-11T00:00:00Z",
          desiredState: "enabled",
          deviceId: "dev",
          generation: 1,
          id: "work_child_docs",
          kind: "agent",
          management: "managed",
          observation: {
            at: "2026-11-11T00:01:00Z",
            confirmedRevision: 1,
            status: "running",
          },
          revision: 1,
          sessionId: "parent",
          source: "foundry",
          sourceId: "child_docs",
          spec: {},
          threadId: "parent",
          title: "更新发布说明",
          updatedAt: "2026-11-11T00:01:00Z",
          workspaceId: "ws",
        },
      ],
      operations: [],
    },
    refresh() {},
    retryControl() {},
    retrying: false,
    sessionId: "parent",
  };
  const render = (reveal) =>
    createElement(
      "div",
      null,
      createElement(ChatThreadHeader, {
        contextOpen: false,
        foldedTurns: 0,
        onlyMine: false,
        onOnlyMineChange() {},
        onBack() {},
        onRevealWaitingChildren() {
          reveals++;
        },
        onToggleContext() {},
        title: "发布协调",
        waitingChildCount: 1,
      }),
      createElement(ChatContextCard, {
        data: {
          background: [],
          changes: [],
          files: [],
          previews: [],
          sources: [],
          subagents: [],
          timers: [],
        },
        reveal,
        work,
      }),
    );

  await act(() => root.render(render(undefined)));

  assert.equal(
    container.querySelector(".fdy-waiting-children-wide")?.textContent,
    "Waiting on 1",
  );
  await act(async () => i18n.changeLanguage("zh-CN"));
  assert.equal(
    container.querySelector(".fdy-waiting-children-wide")?.textContent,
    "等待 1 个子会话",
  );
  const trigger = container.querySelector(
    'button[aria-label="等待 1 个子会话"]',
  );
  assert.ok(trigger);
  assert.equal(trigger.tagName, "BUTTON");
  assert.equal(trigger.getAttribute("type"), "button");
  await act(() => trigger.click());
  assert.equal(reveals, 1);
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(window.location.pathname, "/chats/parent");

  await act(() => root.render(render({ ids: ["work_child_docs"] })));
  const row = container.querySelector(
    '[data-work-kind="agent"] [data-work-id="work_child_docs"]',
  );
  assert.ok(row);
  const selected = row.querySelector('[data-selected="true"]');
  assert.ok(selected);
  const child = selected.querySelector("a");
  assert.ok(child);
  assert.match(child.textContent, /更新发布说明/);
  assert.equal(document.activeElement, child);
});
