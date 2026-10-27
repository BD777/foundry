import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

register("./bundler-resolve.mjs", import.meta.url);
const { useChatSelection } =
  await import("../src/features/chat/use-chat-selection.ts");
const { agentSessionIsAwaitingDetails } =
  await import("../src/lib/agent-session-events.ts");
const { chatViewMessages } =
  await import("../src/features/chat/chat-message-items.ts");

const summary = {
  id: "archived-hydration-fixture",
  threadId: "archived-hydration-fixture",
  workspaceId: "archive-workspace",
  agentId: "agent",
  deviceId: "device",
  provider: "codex",
  source: "chat",
  status: "completed",
  title: "Archived answer",
  prompt: "Synthetic archived prompt",
  createdLabel: "",
  updatedLabel: "",
  archivedAt: "2026-10-27T03:00:00Z",
  archiveBatchId: "batch-1",
};
const event = (id, detail) => ({
  id,
  sessionId: summary.id,
  at: "2026-10-27T02:00:00Z",
  label: "Response stream",
  detail,
  level: "info",
  message: {
    id: `message-${id}`,
    kind: "assistant",
    text: detail,
    status: "completed",
  },
});

test("archived list summaries retain loaded responses and event windows across polling, without reusing details for another archive or workspace", async () => {
  const window = new Window();
  const previous = new Map();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  const root = createRoot(window.document.createElement("div"));
  let selection;
  function Harness({ sessions, workspaceId = summary.workspaceId }) {
    selection = useChatSelection({
      nativeChats: [],
      ready: true,
      selectedChatId: summary.id,
      sessions,
      workspaceId,
    });
    return null;
  }
  const render = (sessions, workspaceId) =>
    act(() => root.render(createElement(Harness, { sessions, workspaceId })));
  const shown = () => selection.selectedThread.sessions[0];
  try {
    await render([summary]);
    assert.equal(
      selection.linked.state,
      "none",
      "the archive summary already counts as listed",
    );
    assert.equal(agentSessionIsAwaitingDetails(shown()), true);

    // This is the exact callback used by useChatTranscript.onLoaded. The
    // shell's active session list has no archived row to receive this load.
    await act(() =>
      selection.mergeLinkedDetails([
        {
          ...summary,
          response: "Readable archived assistant answer",
          events: [event("recent", "Readable archived assistant answer")],
        },
      ]),
    );
    assert.equal(agentSessionIsAwaitingDetails(shown()), false);
    assert.equal(shown().response, "Readable archived assistant answer");
    const projected = chatViewMessages({
      thread: selection.selectedThread,
      outbox: [],
      suppressedResponseFingerprints: new Set(),
    });
    assert.ok(
      projected.messages.some(
        (message) => message.text === "Readable archived assistant answer",
      ),
    );

    await render([{ ...summary, nativeArchive: [{ state: "archived" }] }]);
    assert.equal(
      shown().response,
      "Readable archived assistant answer",
      "a fresh summary must not replace the loaded transcript",
    );
    assert.equal(
      shown().nativeArchive[0].state,
      "archived",
      "new summary metadata still wins",
    );
    assert.deepEqual(
      shown().events.map((item) => item.id),
      ["recent"],
    );
    await act(() =>
      selection.mergeLinkedDetails([
        {
          ...summary,
          response: "Readable archived assistant answer",
          events: [event("earlier", "Earlier answer")],
        },
      ]),
    );
    assert.deepEqual(
      new Set(shown().events.map((item) => item.id)),
      new Set(["earlier", "recent"]),
    );

    const rearchived = {
      ...summary,
      archivedAt: "2026-10-27T04:00:00Z",
      archiveBatchId: "batch-2",
    };
    await render([rearchived]);
    assert.equal(
      shown().events,
      undefined,
      "a later archive may follow more conversation turns",
    );
    await act(() =>
      selection.mergeLinkedDetails([
        {
          ...rearchived,
          response: "Later archived answer",
          events: [event("later", "Later archived answer")],
        },
      ]),
    );
    assert.deepEqual(
      shown().events.map((item) => item.id),
      ["later"],
      "a rearchive's load cannot inherit the previous archive's event window",
    );
    await render([
      {
        ...summary,
        archivedAt: undefined,
        archiveBatchId: undefined,
        response: "New active answer",
        events: [event("active", "New active answer")],
      },
    ]);
    assert.equal(
      shown().response,
      "New active answer",
      "restored chats use their live projection",
    );
    assert.deepEqual(
      shown().events.map((item) => item.id),
      ["active"],
    );
    await render(
      [{ ...summary, workspaceId: "different-workspace" }],
      "different-workspace",
    );
    assert.equal(
      shown().events,
      undefined,
      "cached archive details cannot cross workspace scope",
    );
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await window.happyDOM.close();
  }
});
