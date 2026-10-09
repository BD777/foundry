import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
register("./bundler-resolve.mjs", import.meta.url);

// Node 22 has no global localStorage; the browser's comes from happy-dom.
const window = new Window();
Object.assign(globalThis, {
  window,
  document: window.document,
  localStorage: window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { useChatRuntime } =
  await import("../src/features/chat/use-chat-runtime.ts");
const { restoredChatRuntime } =
  await import("../src/features/chat/chat-runtime-choice.ts");
const { clearConversationStorage, moveRuntimeChoice } =
  await import("../src/components/conversation/conversation-storage.ts");

const agent = (id, provider) => ({
  id,
  provider,
  status: "healthy",
  workspaceId: "ws",
  deviceId: "dev",
});
const agents = [agent("agent_claude", "claude"), agent("agent_codex", "codex")];
const session = (fields) => ({
  id: "ses_1",
  agentId: "agent_claude",
  provider: "claude",
  status: "completed",
  title: "t",
  prompt: "p",
  createdLabel: "",
  updatedLabel: "",
  input: { id: "in_1", prompt: "p", at: "2020-01-01T10:00:00Z" },
  ...fields,
});

/** Mounts the hook as the chat page does; `unmount` is a page reload. */
async function mountRuntime(props) {
  let runtime;
  function Probe() {
    runtime = useChatRuntime({
      active: true,
      agents,
      onNotice: () => undefined,
      profiles: [],
      selectedChatId: "",
      workspaceId: "ws",
      ...props,
    });
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(createElement(Probe)));
  return {
    get: () => runtime,
    unmount: () => act(async () => root.unmount()),
  };
}

test("a new chat's agent and model survive a reload and move with its first message", async () => {
  clearConversationStorage();
  const before = await mountRuntime({ threadKey: "ws:new" });
  await act(async () => before.get().selectAgent("agent_claude"));
  await act(async () => before.get().updateOverride({ model: "haiku" }));
  assert.equal(before.get().modelValue, "haiku");
  await before.unmount();

  const after = await mountRuntime({ threadKey: "ws:new" });
  assert.equal(after.get().selectedAgent?.id, "agent_claude");
  assert.equal(after.get().modelValue, "haiku");
  await after.unmount();

  moveRuntimeChoice("ws:new", "ws:thr_1");
  const moved = await mountRuntime({ threadKey: "ws:thr_1" });
  assert.equal(moved.get().modelValue, "haiku");
  await moved.unmount();
  const fresh = await mountRuntime({ threadKey: "ws:new" });
  assert.notEqual(fresh.get().modelValue, "haiku");
  await fresh.unmount();
});

test("an existing chat restores the session's model, or a choice made after it", async () => {
  clearConversationStorage();
  const thread = {
    id: "thr_2",
    title: "t",
    sessions: [session({ model: "sonnet", claudeEffort: "low" })],
  };
  const props = {
    selectedChatId: "thr_2",
    selectedThread: thread,
    threadKey: "ws:thr_2",
  };
  const opened = await mountRuntime(props);
  assert.equal(opened.get().selectedAgent?.id, "agent_claude");
  assert.equal(opened.get().modelValue, "sonnet");
  assert.equal(opened.get().claudeEffort, "low");
  // Chosen after the latest message (e.g. for a queued one): kept on reload.
  await act(async () => opened.get().updateOverride({ model: "haiku" }));
  await opened.unmount();
  const reloaded = await mountRuntime(props);
  assert.equal(reloaded.get().modelValue, "haiku");
  assert.equal(reloaded.get().claudeEffort, "low");
  await reloaded.unmount();
});

test("a session newer than the stored choice wins where it recorded the runtime", () => {
  const stored = {
    choice: {
      agentId: "agent_claude",
      override: { model: "haiku", claudeEffort: "max" },
    },
    updatedAt: Date.parse("2020-01-01T09:00:00Z"),
  };
  assert.deepEqual(
    restoredChatRuntime({ latest: session({ model: "opus" }), stored }),
    {
      agentId: "agent_claude",
      override: { model: "opus", claudeEffort: "max" },
    },
  );
  assert.deepEqual(
    restoredChatRuntime({
      latest: session({
        agentId: "agent_codex",
        codexReasoningEffort: "medium",
      }),
      stored,
    }),
    { agentId: "agent_codex", override: { codexReasoningEffort: "medium" } },
  );
  assert.deepEqual(restoredChatRuntime({ stored }), stored.choice);
  assert.equal(restoredChatRuntime({}), undefined);
});
