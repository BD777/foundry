import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
register("./bundler-resolve.mjs", import.meta.url);

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
function setup(t, fetcher = async () => new Response("[]")) {
  const window = new Window({ url: "http://foundry.test/chats" });
  const previous = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    fetch: fetcher,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
    EventSource: class {
      addEventListener() {}
      close() {}
    },
  };
  for (const key of [
    "Node",
    "Element",
    "HTMLElement",
    "HTMLDivElement",
    "HTMLTextAreaElement",
    "HTMLInputElement",
    "HTMLButtonElement",
    "MutationObserver",
    "ResizeObserver",
    "IntersectionObserver",
    "CustomEvent",
    "Event",
    "MouseEvent",
    "PointerEvent",
    "KeyboardEvent",
    "NodeFilter",
    "DOMRect",
    "Range",
  ])
    globals[key] = window[key];
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => {
      root.unmount();
      await tick();
    });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await window.happyDOM.close();
  });
  return { window, container, root };
}
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const result = {
  batchId: "batch",
  archived: ["row"],
  blockers: [],
  pausedWork: [],
};

test("archive blocker codes are localized in both languages and legacy server prose is not used as fallback", async () => {
  const { i18n } = await import("../src/i18n/index.ts");
  const { archiveBlockerReason } =
    await import("../src/features/chat/chat-archive-reasons.ts");
  const expected = {
    en: {
      running: "Stop this chat first.",
      personal_agent: "The assistant’s home chat cannot be archived.",
      issue_owned: "Managed by Issue iss_fixture.",
      work_unpausable: "Stop this work first: Reminder.",
      work_shared:
        "Shared work: Reminder. Stopping it also affects linked chats.",
    },
    "zh-CN": {
      running: "请先停止此对话。",
      personal_agent: "无法归档助理的主对话。",
      issue_owned: "由事项 iss_fixture 管理。",
      work_unpausable: "请先停止工作：Reminder。",
      work_shared: "共享工作：Reminder。停止它也会影响关联的对话。",
    },
  };
  for (const [language, codes] of Object.entries(expected)) {
    await i18n.changeLanguage(language);
    for (const [code, text] of Object.entries(codes))
      assert.equal(
        archiveBlockerReason({
          id: "row",
          code,
          issueId: "iss_fixture",
          workTitle: "Reminder",
          reason: "Legacy English blocker",
        }),
        text,
      );
    const fallback = archiveBlockerReason({
      id: "row",
      reason: "Legacy English blocker",
    });
    assert.equal(fallback, i18n.t("chat:archive.reasons.unknown"));
    assert.doesNotMatch(fallback, /Legacy English/);
  }
  await i18n.changeLanguage("en");
});

test("busy archive calls reject; a successful restore disappears optimistically even when its refresh fails", async (t) => {
  let release;
  let mutations = 0;
  let failRefresh = false;
  const row = {
    id: "row",
    title: "Archived row",
    workspaceId: "archive-fixture",
    archivedAt: "2026-10-27T03:00:00Z",
    readonly: false,
    preview: "",
  };
  const { root } = setup(t, async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      mutations++;
      if (url.pathname.endsWith("/unarchive")) {
        failRefresh = true;
        return json(result);
      }
      return new Promise((resolve) => {
        release = () => resolve(json(result));
      });
    }
    if (failRefresh) return json({ error: "Synthetic refresh failure" }, 503);
    return json(url.pathname === "/api/chats" ? [row] : []);
  });
  const { useChatArchive } =
    await import("../src/features/chat/use-chat-archive.ts");
  const { archivedChatRows } =
    await import("../src/features/chat/chat-archive-model.ts");
  let archive;
  function Harness() {
    archive = useChatArchive("archive-fixture", false);
    return null;
  }
  await act(() => root.render(createElement(Harness)));
  let first;
  await act(async () => {
    first = archive.change({ chatIds: ["row"] });
    await tick();
  });
  assert.equal(archive.busy, true);
  await assert.rejects(
    archive.change({ chatIds: ["row"] }),
    /Another archive operation/,
  );
  assert.equal(
    mutations,
    1,
    "reentry cannot start a second request or report success",
  );
  await act(async () => {
    release();
    await first;
  });
  assert.equal(archive.chats.length, 1);
  await act(async () => {
    await archive.change({ chatIds: ["row"] }, true);
  });
  assert.equal(
    archive.chats.length,
    1,
    "failed refresh keeps the old server snapshot",
  );
  assert.equal(archive.restored.has("row"), true);
  assert.deepEqual(
    archivedChatRows(archive.chats, archive.sessions, archive.restored, {}),
    [],
  );
  assert.match(archive.error, /Synthetic refresh failure/);
});

test("archive from a row context menu uses shared Dialog, retains a rejected operation, and returns focus to its originating row", async (t) => {
  const { container, root, window } = setup(t, async () => json(result));
  const { i18n } = await import("../src/i18n/index.ts");
  await i18n.changeLanguage("en");
  const { ChatListRow } =
    await import("../src/features/chat/chat-list-row.tsx");
  const { ChatArchiveDialog } =
    await import("../src/features/chat/chat-archive-dialog.tsx");
  const { ToastProvider } = await import("../src/components/ui/toast.tsx");
  const chat = {
    id: "row",
    title: "Original chat row",
    unread: false,
    status: "idle",
    foundrySessionId: "row",
    onSelect() {},
    onRename: async () => {},
    onAutoRename: async () => {},
    onMarkUnread() {},
    onNotify() {},
  };
  let closed = 0;
  function Harness() {
    const [opener, setOpener] = useState(null);
    return createElement(
      "div",
      null,
      createElement(ChatListRow, {
        chat,
        groupMenu: {
          groups: [],
          disabled: false,
          onMove() {},
          onNewGroup() {},
        },
        onArchive: setOpener,
      }),
      opener
        ? createElement(ChatArchiveDialog, {
            input: { workspaceId: "archive-fixture", chatIds: ["row"] },
            titles: { row: chat.title },
            returnFocusTo: opener,
            onClose: () => {
              closed++;
              setOpener(null);
            },
            onArchive: async () => {
              throw new Error("Another archive operation is still running");
            },
          })
        : null,
    );
  }
  await act(() =>
    root.render(createElement(ToastProvider, null, createElement(Harness))),
  );
  const origin = container.querySelector(".fdy-chat-row");
  await act(() =>
    origin.dispatchEvent(
      new window.MouseEvent("contextmenu", {
        bubbles: true,
        button: 2,
        clientX: 20,
        clientY: 20,
      }),
    ),
  );
  const menu = [...document.querySelectorAll('[role="menuitem"]')].find(
    (item) => item.textContent.trim() === "Archive",
  );
  assert.ok(menu);
  await act(async () => {
    menu.click();
    await tick();
  });
  assert.ok(
    document.querySelector(".fdy-dialog-layer .fdy-dialog"),
    "shared Dialog owns the surface",
  );
  const confirm = [...document.querySelectorAll("button")].find(
    (item) => item.textContent.trim() === "Archive 1 chat",
  );
  assert.ok(confirm);
  await act(async () => {
    confirm.click();
    await tick();
  });
  assert.equal(closed, 0);
  assert.ok(
    document.querySelector('[role="dialog"]'),
    "rejected reentry must not close the dialog as success",
  );
  assert.match(
    document.querySelector('.fdy-toast[data-tone="error"]').textContent,
    /Another archive operation/,
  );
  const cancel = [...document.querySelectorAll("button")].find(
    (item) => item.textContent.trim() === "Cancel",
  );
  await act(() => cancel.click());
  await act(async () => {
    await tick();
  });
  assert.equal(document.activeElement, origin);
});

test("real ChatSurface floats Undo and errors without inserting a layout banner, and archived copy/date use the selected locale once", async (t) => {
  const { container, root } = setup(t, async (input) =>
    json(
      String(input).includes("chat-layout")
        ? { revision: 1, groups: [], positions: [] }
        : [],
    ),
  );
  const { i18n } = await import("../src/i18n/index.ts");
  await i18n.changeLanguage("en");
  const { ChatSurface } = await import("../src/features/chat/chat-surface.tsx");
  const { ChatArchiveBanner } =
    await import("../src/features/chat/chat-archive-banner.tsx");
  const { archiveSurfaceProps } =
    await import("./fixtures/chat-archive-surface-props.ts");
  const { ToastProvider } = await import("../src/components/ui/toast.tsx");
  let undo = 0;
  await act(() =>
    root.render(
      createElement(
        ToastProvider,
        null,
        createElement(
          ChatSurface,
          archiveSurfaceProps({
            archiveToast: {
              count: 2,
              busy: false,
              onUndo: async () => {
                undo++;
              },
            },
            archiveError: "Synthetic archive failure",
          }),
        ),
      ),
    ),
  );
  const screen = container.querySelector(".fdy-chat-screen");
  assert.equal(screen.dataset.narrowPane, "list");
  assert.equal(container.querySelector(".fdy-chat-archive-feedback"), null);
  const feedback = container.querySelector(".fdy-toast-viewport");
  assert.ok(feedback);
  assert.equal(feedback.closest(".fdy-chat-screen"), null);
  assert.match(feedback.textContent, /Archived 2 chats/);
  assert.match(feedback.textContent, /Synthetic archive failure/);
  await act(() =>
    [...feedback.querySelectorAll("button")]
      .find((item) => item.textContent.trim() === "Undo")
      .click(),
  );
  assert.equal(undo, 1);
  await act(() => i18n.changeLanguage("zh-CN"));
  const at = "2026-10-27T03:00:00Z";
  await act(() =>
    root.render(
      createElement(
        ChatSurface,
        archiveSurfaceProps({
          archiveBanner: createElement(ChatArchiveBanner, {
            chat: {
              id: "row",
              title: "Archived row",
              archivedAt: at,
              archivedByLabel: "Synthetic user",
            },
            workspaceId: "archive-fixture",
            busy: false,
            onUnarchive: async () => {},
            onRefresh: async () => {},
          }),
        }),
      ),
    ),
  );
  assert.ok(
    container.textContent.includes(new Date(at).toLocaleString("zh-CN")),
  );
  assert.equal(
    container.textContent.split(i18n.t("chat:archive.continue")).length - 1,
    1,
  );
  const { ArchivedChatsView } =
    await import("../src/features/chat/archived-chats-view.tsx");
  for (const language of ["en", "zh-CN"]) {
    await act(() => i18n.changeLanguage(language));
    await act(() =>
      root.render(
        createElement(ArchivedChatsView, {
          workspaceId: "archive-fixture",
          chats: [
            {
              id: "actor-row",
              title: "Archived actor row",
              archivedAt: at,
              archivedByLabel: "Synthetic actor",
            },
            {
              id: "agent-row",
              title: "Archived agent row",
              archivedAt: at,
              archivedBySession: "sess_do_not_expose_as_actor",
            },
          ],
          busy: false,
          error: "",
          readOnly: false,
          onUnarchive: async () => {},
          onRetry: async () => {},
        }),
      ),
    );
    assert.ok(
      container.textContent.includes(
        i18n.t("chat:archive.byActor", { actor: "Synthetic actor" }),
      ),
    );
    assert.ok(
      container.textContent.includes(
        i18n.t("chat:archive.byActor", {
          actor: i18n.t("chat:archive.agentActor"),
        }),
      ),
    );
    assert.doesNotMatch(container.textContent, /sess_do_not_expose_as_actor/);
  }
});

test("offered blocker controls use the exact scoped APIs and only verified work receipts clear pending state", async (t) => {
  const requests = [];
  let receiptState = "pending";
  let saved;
  setup(t, async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path: url.pathname, method: init?.method ?? "GET", body });
    if (url.pathname.endsWith("/cancel"))
      return json({ id: "row", status: "canceled" });
    if (url.pathname.endsWith("/work/operations"))
      return json({
        id: "operation",
        state: "pending",
        items: [{ id: "work", revision: 8 }],
      });
    if (url.pathname.endsWith("/work"))
      return json({ operations: [{ id: "operation", state: receiptState }] });
    if (url.pathname === "/api/chat-layout" && init?.method === "POST") {
      saved = body;
      return json(body.layout);
    }
    if (url.pathname === "/api/chat-layout")
      return json({
        revision: 9,
        groups: [{ id: "folder", name: "Folder" }],
        positions: [
          { chatId: "row", groupId: "folder" },
          { chatId: "other", groupId: "folder" },
        ],
      });
    throw new Error(`Unexpected synthetic API ${url.pathname}`);
  });
  const { i18n } = await import("../src/i18n/index.ts");
  await i18n.changeLanguage("en");
  const { resolveArchiveBlocker, checkArchiveBlockerResolution } =
    await import("../src/features/chat/chat-archive-controls.ts");
  const input = { workspaceId: "archive-fixture", groupId: "folder" };
  const work = {
    id: "row",
    code: "work_shared",
    reason: "legacy",
    action: "stop_work",
    workId: "work",
    workSessionId: "owner",
    workRevision: 7,
    workReferenceRevision: 3,
  };
  const pending = await resolveArchiveBlocker(work, input);
  assert.equal(pending.state, "pending");
  const request = requests.find((item) =>
    item.path.endsWith("/work/operations"),
  );
  assert.equal(request.path, "/api/agent-sessions/owner/work/operations");
  assert.equal(request.body.id, "work");
  assert.equal(request.body.action, "stop");
  assert.equal(request.body.expectedRevision, 7);
  assert.equal(request.body.expectedReferenceRevision, 3);
  assert.match(request.body.idempotencyKey, /^[\da-f-]{36}$/i);
  assert.equal(
    (await checkArchiveBlockerResolution(work, pending)).state,
    "pending",
    "a sent request is not proof that work stopped",
  );
  receiptState = "verified";
  assert.equal(
    (await checkArchiveBlockerResolution(work, pending)).state,
    "verified",
  );
  await resolveArchiveBlocker({ ...work, action: "unlink_work" }, input);
  assert.equal(requests.at(-1).body.action, "unlink");
  assert.equal(requests.at(-1).body.relatedSessionId, "row");
  await resolveArchiveBlocker(
    { id: "row", reason: "legacy", action: "remove_from_folder" },
    input,
  );
  assert.equal(saved.expectedRevision, 9);
  assert.deepEqual(saved.layout.positions, [
    { chatId: "row", groupId: "" },
    { chatId: "other", groupId: "folder" },
  ]);
  assert.equal(
    requests.some((item) => /delete/.test(item.path)),
    false,
    "moving out of a folder never deletes the chat",
  );
  assert.equal(
    (
      await resolveArchiveBlocker(
        {
          id: "row",
          code: "running",
          reason: "legacy",
          action: "stop_session",
        },
        input,
      )
    ).state,
    "verified",
  );
  assert.equal(requests.at(-1).path, "/api/agent-sessions/row/cancel");
  const calls = requests.length;
  await assert.rejects(
    resolveArchiveBlocker(
      { id: "row", code: "work_unpausable", reason: "legacy" },
      input,
    ),
    /no longer available/,
  );
  assert.equal(
    requests.length,
    calls,
    "unavailable controls cannot infer or send a stop",
  );
  assert.equal(
    requests.some((item) => item.path === "/api/chats/archive"),
    false,
    "a resolving action never archives implicitly",
  );
});

test("five-chat preflight is compact, while real managed blockers offer a resolving action and wait for verified receipts", async (t) => {
  const ids = ["row", "second", "third", "fourth", "fifth"];
  let workPending = true;
  let verifyReceipt = false;
  let controlRequests = 0;
  const blocker = {
    id: "row",
    reason: "Old English blocker text",
    code: "work_shared",
    workTitle: "Preview server",
    action: "stop_work",
    workId: "work",
    workSessionId: "owner",
    workRevision: 1,
    workReferenceRevision: 2,
  };
  const { root, container } = setup(t, async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/work/operations")) {
      controlRequests++;
      workPending = false;
      return json({
        id: "operation",
        state: "pending",
        items: [{ id: "work", revision: 2 }],
      });
    }
    if (path.endsWith("/work"))
      return json({
        operations: [
          { id: "operation", state: verifyReceipt ? "verified" : "pending" },
        ],
      });
    if (path === "/api/chats/archive")
      return json({
        ...result,
        archived: ids,
        blockers: workPending ? [blocker] : [],
      });
    throw new Error(`Unexpected synthetic API ${path}`);
  });
  const { i18n } = await import("../src/i18n/index.ts");
  await i18n.changeLanguage("en");
  const { ChatArchiveDialog } =
    await import("../src/features/chat/chat-archive-dialog.tsx");
  let archived = 0;
  const titles = Object.fromEntries(
    ids.map((id) => [
      id,
      id === "third"
        ? "A very long completed chat title that must stay on one line with ellipsis instead of a paragraph"
        : `${id} chat`,
    ]),
  );
  await act(async () => {
    root.render(
      createElement(ChatArchiveDialog, {
        input: { workspaceId: "archive-fixture", groupId: "folder" },
        titles,
        onClose() {},
        onArchive: async () => {
          archived++;
        },
      }),
    );
    await tick();
  });
  await act(async () => {
    await tick();
  });
  assert.equal(
    document.querySelector(".fdy-chat-archive-included h3").textContent,
    "5 chats",
  );
  assert.equal(
    document.querySelectorAll(".fdy-chat-archive-included li").length,
    5,
  );
  assert.equal(
    document.querySelector(".fdy-chat-archive-included li:nth-child(3) span")
      .title,
    titles.third,
  );
  assert.equal(
    document.querySelector(".fdy-chat-archive-native-details").open,
    false,
  );
  assert.equal(document.querySelector(".fdy-chat-archive-paused"), null);
  assert.doesNotMatch(
    document.querySelector(".fdy-dialog-description").textContent,
    /Codex|subagent/,
  );
  const button = (label) =>
    [...document.querySelectorAll("button")].find(
      (item) => item.textContent.trim() === label,
    );
  assert.equal(
    button("Open"),
    undefined,
    "blockers cannot offer a dead-end Open link",
  );
  assert.ok(button("Stop work"));
  assert.match(
    document.querySelector('[role="alert"]').textContent,
    /also affects linked chats/,
  );
  assert.match(
    document.querySelector(".fdy-chat-archive-disabled-reason").textContent,
    /Resolve the blockers/,
  );
  assert.equal(button("Archive 5 chats").disabled, true);
  assert.ok(button("Refresh").closest('[role="alert"]'));
  await act(async () => {
    button("Stop work").click();
    await tick();
  });
  await act(async () => {
    await tick();
  });
  assert.equal(controlRequests, 1);
  assert.equal(
    button("Archive 5 chats").disabled,
    true,
    "pending receipt stays blocking even after the server's desired state no longer blocks preflight",
  );
  assert.match(
    document.querySelector(".fdy-chat-archive-disabled-reason").textContent,
    /Waiting for the device/,
  );
  await act(async () => {
    button("Refresh").click();
    await tick();
  });
  await act(async () => {
    await tick();
  });
  assert.equal(button("Archive 5 chats").disabled, true);
  verifyReceipt = true;
  await act(async () => {
    button("Refresh").click();
    await tick();
  });
  await act(async () => {
    await tick();
  });
  assert.equal(button("Archive 5 chats").disabled, false);
  assert.equal(
    button("Refresh"),
    undefined,
    "Refresh only appears with blockers",
  );
  assert.equal(document.querySelector('[role="alert"]'), null);
  await act(async () => {
    button("Archive 5 chats").click();
    await tick();
  });
  assert.equal(archived, 1);
  assert.ok(container);
});

test("unavailable work is explained without a fake resolving link or inferred stop", async (t) => {
  const { root } = setup(t, async () =>
    json({
      ...result,
      blockers: [
        {
          id: "row",
          reason: "English-only legacy details",
          code: "work_unpausable",
          workTitle: "External task",
        },
      ],
    }),
  );
  const { i18n } = await import("../src/i18n/index.ts");
  await i18n.changeLanguage("en");
  const { ChatArchiveDialog } =
    await import("../src/features/chat/chat-archive-dialog.tsx");
  await act(async () => {
    root.render(
      createElement(ChatArchiveDialog, {
        input: { workspaceId: "archive-fixture", groupId: "folder" },
        titles: { row: "Chat" },
        onClose() {},
        onArchive: async () => {},
      }),
    );
    await tick();
  });
  await act(async () => {
    await tick();
  });
  const text = document.querySelector('[role="alert"]').textContent;
  assert.match(text, /No resolving control is available here/);
  assert.doesNotMatch(text, /English-only legacy/);
  assert.equal(
    [...document.querySelectorAll("button")].some((item) =>
      ["Open", "Stop work", "Stop chat"].includes(item.textContent.trim()),
    ),
    false,
  );
  assert.ok(document.querySelector(".fdy-chat-archive-disabled-reason"));
});

test("a failed control receipt stays blocking until an explicit retry is verified", async (t) => {
  let sent = false;
  let retry = false;
  const blocker = {
    id: "row",
    code: "work_unpausable",
    reason: "legacy",
    workTitle: "Managed preview",
    workId: "work",
    workSessionId: "owner",
    action: "stop_work",
  };
  const { root } = setup(t, async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/work/operations")) {
      sent = true;
      return json({
        id: retry ? "retry-operation" : "operation",
        state: retry ? "verified" : "pending",
      });
    }
    if (path.endsWith("/work"))
      return json({ operations: [{ id: "operation", state: "failed" }] });
    return json({ ...result, blockers: sent ? [] : [blocker] });
  });
  const { i18n } = await import("../src/i18n/index.ts");
  await i18n.changeLanguage("en");
  const { ChatArchiveDialog } =
    await import("../src/features/chat/chat-archive-dialog.tsx");
  await act(async () => {
    root.render(
      createElement(ChatArchiveDialog, {
        input: { workspaceId: "archive-fixture" },
        titles: { row: "Managed chat" },
        onClose() {},
        onArchive: async () => {},
      }),
    );
    await tick();
  });
  await act(async () => {
    await tick();
  });
  const button = (label) =>
    [...document.querySelectorAll("button")].find(
      (item) => item.textContent.trim() === label,
    );
  await act(async () => {
    button("Stop work").click();
    await tick();
  });
  await act(async () => {
    await tick();
  });
  await act(async () => {
    button("Refresh").click();
    await tick();
  });
  await act(async () => {
    await tick();
  });
  assert.equal(button("Archive 1 chat").disabled, true);
  assert.match(
    document.querySelector(".fdy-chat-archive-disabled-reason").textContent,
    /control failed/,
  );
  assert.equal(
    button("Stop work").disabled,
    false,
    "failed controls can be retried explicitly, never treated as stopped",
  );
  retry = true;
  await act(async () => {
    button("Stop work").click();
    await tick();
  });
  await act(async () => {
    await tick();
  });
  assert.equal(button("Archive 1 chat").disabled, false);
});

test("a failed preflight reports failure instead of perpetual loading or an empty-folder claim, and Retry recovers", async (t) => {
  let failed = true;
  const { root } = setup(t, async () =>
    failed
      ? json({ error: "Synthetic preflight unavailable" }, 503)
      : json(result),
  );
  const { i18n } = await import("../src/i18n/index.ts");
  await i18n.changeLanguage("en");
  const { ChatArchiveDialog } =
    await import("../src/features/chat/chat-archive-dialog.tsx");
  await act(async () => {
    root.render(
      createElement(ChatArchiveDialog, {
        input: { workspaceId: "archive-fixture" },
        titles: { row: "Chat" },
        onClose() {},
        onArchive: async () => {},
      }),
    );
    await tick();
  });
  await act(async () => {
    await tick();
  });
  assert.match(
    document.querySelector('[role="alert"]').textContent,
    /Synthetic preflight unavailable/,
  );
  assert.equal(
    document.querySelector(".fdy-chat-archive-disabled-reason").textContent,
    "Could not update chat archive",
  );
  assert.doesNotMatch(
    document.querySelector('[role="dialog"]').textContent,
    /Checking chats and linked work|No chats to archive/,
  );
  failed = false;
  await act(async () => {
    [...document.querySelectorAll("button")]
      .find((item) => item.textContent.trim() === "Retry")
      .click();
    await tick();
  });
  await act(async () => {
    await tick();
  });
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.equal(
    [...document.querySelectorAll("button")].find(
      (item) => item.textContent.trim() === "Archive 1 chat",
    ).disabled,
    false,
  );
});
