import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { act, createElement } from "react";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function withDom(body) {
  const window = new Window({ url: "http://127.0.0.1/" });
  const previous = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of [
    "Node",
    "Element",
    "HTMLElement",
    "HTMLButtonElement",
    "Event",
    "MouseEvent",
    "getComputedStyle",
  ])
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
    await import("../src/i18n/index.ts");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await body(container, root);
    await act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    await window.happyDOM.close();
  }
}

const designPath = "/home/me/repo/.foundry/attachments/design.md";
const pendingDesign = {
  text: ".foundry/attachments/design.md",
  path: designPath,
  kind: "file",
  pending: true,
};
const app = {
  text: "src/app.ts",
  path: "/home/me/repo/src/app.ts",
  kind: "file",
};

function event(id, second, label, detail, metadata, message) {
  return {
    at: `2026-10-11T02:10:${String(second).padStart(2, "0")}.000Z`,
    detail,
    id,
    label,
    level: "info",
    ...(metadata ? { metadata } : {}),
    ...(message ? { message } : {}),
    sessionId: "sess_test",
  };
}

/** A turn whose answer names the design doc before a subagent writes it. */
function turnEvents() {
  return [
    event("evt_in", 0, "User message", "", undefined, {
      id: "in_1",
      kind: "user",
      text: "write the design",
    }),
    event("evt_answer", 2, "Response stream", "", undefined, {
      id: "a_1",
      kind: "assistant",
      text: "The design will be at `.foundry/attachments/design.md`; see `src/app.ts`.",
    }),
    event("evt_done", 3, "Claude Agent SDK finished", "", {
      fileReferences: [pendingDesign, app],
    }),
  ];
}

function recordedDesign(id, second, op) {
  return event(id, second, "Recorded file", ".foundry/attachments/design.md", {
    sessionFile: {
      path: designPath,
      workspacePath: ".foundry/attachments/design.md",
      origin: "tool",
      op,
      inGitRepo: false,
      inputId: "in_1",
      agent: "agent_9",
    },
  });
}

function session(events) {
  return {
    agentId: "agent_test",
    createdLabel: "just now",
    deviceId: "dev_test",
    events,
    id: "sess_test",
    prompt: "write the design",
    provider: "claude",
    status: "completed",
    title: "design",
    updatedLabel: "completed",
    workspaceId: "ws_test",
  };
}

async function answerFor(events) {
  const { chatMessagesForThread } =
    await import("../src/features/chat/chat-model.ts");
  return chatMessagesForThread({
    id: "t",
    sessions: [session(events)],
    title: "t",
  }).find((message) => message.role === "bot" && !message.kind);
}

test("a pending reference settles once the session records its file", async () => {
  const before = await answerFor(turnEvents());
  assert.deepEqual(before.fileReferences, [
    { ...pendingDesign, sessionId: "sess_test" },
    app,
  ]);
  // The background subagent writes it after the turn ended.
  const after = await answerFor([
    ...turnEvents(),
    recordedDesign("evt_write", 40, "created"),
  ]);
  assert.deepEqual(after.fileReferences, [
    { text: pendingDesign.text, path: designPath, kind: "file" },
    app,
  ]);
  // A file recorded and then deleted is still not there.
  const deleted = await answerFor([
    ...turnEvents(),
    recordedDesign("evt_write", 40, "created"),
    recordedDesign("evt_delete", 50, "deleted"),
  ]);
  assert.equal(deleted.fileReferences[0].pending, true);
});

test("a pending link turns into a file link when its Recorded file arrives", async () => {
  await withDom(async (container, root) => {
    const { ChatMessageRow } =
      await import("../src/components/conversation/chat-message-list.tsx");
    const opened = [];
    const fileActions = {
      open: (reference) => opened.push(reference),
      showTurn: () => {},
    };
    const render = async (message) => {
      await act(async () =>
        root.render(createElement(ChatMessageRow, { fileActions, message })),
      );
      for (let index = 0; index < 3; index += 1) await act(tick);
    };
    const link = () =>
      [...container.querySelectorAll(".fdy-chat-file-reference")].find(
        (button) => button.textContent === pendingDesign.text,
      );

    await render(await answerFor(turnEvents()));
    assert.equal(link().getAttribute("data-pending"), "true");
    assert.ok(link().querySelector("svg.lucide-file-clock"));
    assert.equal(
      link().getAttribute("title"),
      `Open ${designPath} (not written yet when this answer ended)`,
    );
    await act(async () => link().click());
    assert.deepEqual(opened.at(-1), {
      ...pendingDesign,
      sessionId: "sess_test",
    });

    await render(
      await answerFor([
        ...turnEvents(),
        recordedDesign("evt_write", 40, "created"),
      ]),
    );
    assert.equal(link().getAttribute("data-pending"), null);
    assert.ok(link().querySelector("svg.lucide-file-text"));
    assert.equal(link().getAttribute("title"), `Open ${designPath}`);
    await act(async () => link().click());
    assert.deepEqual(opened.at(-1), {
      text: pendingDesign.text,
      path: designPath,
      kind: "file",
    });
  });
});

test("opening a pending file that is still missing says it is not there yet", async () => {
  const { pendingSessionFile } =
    await import("../src/features/chat/pending-file-references.ts");
  const missing = {
    sessionId: "sess_test",
    path: designPath,
    workspacePath: ".foundry/attachments/design.md",
    origin: "reference",
    insideWorkspace: true,
    kind: "missing",
    truncated: false,
    changedSinceRecorded: false,
  };
  await withDom(async (container, root) => {
    const { ChatDetailPanel } =
      await import("../src/features/chat/chat-detail-panel.tsx");
    const render = (selection) =>
      act(async () =>
        root.render(
          createElement(ChatDetailPanel, {
            file: missing,
            loading: false,
            onClose: () => {},
            selection,
          }),
        ),
      );
    const selection = pendingSessionFile(pendingDesign, "sess_test", "ws_test");
    assert.deepEqual(
      [selection.label, selection.sessionId, selection.pending],
      ["design.md", "sess_test", true],
    );
    await render(selection);
    const status = container.querySelector(".fdy-chat-file-banner");
    assert.equal(status.getAttribute("role"), "status");
    assert.match(status.textContent, /Not on the device yet\./);
    assert.match(status.textContent, /opens here once it exists/);
    assert.match(
      container.querySelector(".fdy-chat-file-path").textContent,
      /^\.foundry\/attachments\/design\.md$/,
    );
    // A recorded file that is gone still reads as gone.
    await render({ ...selection, pending: undefined });
    assert.match(
      container.querySelector(".fdy-chat-file-banner").textContent,
      /No longer exists on the device\./,
    );
  });
});
