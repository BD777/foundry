import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// Registered before the dynamic import so the resolver covers the whole graph.
register("./bundler-resolve.mjs", import.meta.url);
const { firstLoadedChatId, resolveLoadedChatSelection } =
  await import("../src/app/chat-selection.ts");

function loaded(overrides = {}) {
  return {
    sessions: [],
    chatThreads: [],
    chats: [],
    preferredChatId: "",
    ...overrides,
  };
}

test("a selected chat survives a load that still contains it", () => {
  const selection = loaded({
    chats: [{ id: "chat_1" }, { id: "chat_2" }],
    preferredChatId: "chat_1",
  });

  assert.equal(resolveLoadedChatSelection(selection, "chat_2"), "chat_2");
});

test("a selected thread survives a load that still contains it", () => {
  const selection = loaded({
    chatThreads: [{ id: "thread_1" }, { id: "thread_2" }],
  });

  assert.equal(resolveLoadedChatSelection(selection, "thread_2"), "thread_2");
});

test("a selected raw session survives even when only its thread is listed", () => {
  const selection = loaded({
    sessions: [{ id: "sess_1" }],
    chatThreads: [{ id: "thread_1" }],
  });

  assert.equal(resolveLoadedChatSelection(selection, "sess_1"), "sess_1");
});

test("a stale selection falls back to the first loaded thread", () => {
  const selection = loaded({
    chatThreads: [{ id: "thread_1" }, { id: "thread_2" }],
    chats: [{ id: "chat_1" }],
    preferredChatId: "chat_1",
  });

  assert.equal(resolveLoadedChatSelection(selection, "gone"), "thread_1");
});

test("a stale selection falls back to the preferred chat without threads", () => {
  const selection = loaded({
    chats: [{ id: "chat_1" }],
    preferredChatId: "chat_1",
  });

  assert.equal(resolveLoadedChatSelection(selection, "gone"), "chat_1");
});

test("an empty load resolves to no selection", () => {
  assert.equal(resolveLoadedChatSelection(loaded(), "gone"), "");
  assert.equal(resolveLoadedChatSelection(loaded(), ""), "");
  assert.equal(firstLoadedChatId(loaded()), "");
});

test("the first loaded chat prefers a thread over the preferred chat", () => {
  assert.equal(
    firstLoadedChatId(
      loaded({ chatThreads: [{ id: "thread_1" }], preferredChatId: "chat_1" }),
    ),
    "thread_1",
  );
  assert.equal(
    firstLoadedChatId(loaded({ preferredChatId: "chat_1" })),
    "chat_1",
  );
});

test("a session Chats does not list (an Issue's) stays selected", () => {
  // Opened by its link, an Issue's session must not give way to the newest
  // chat when the workspace's data loads.
  const selection = loaded({
    sessions: [{ id: "sess_chat" }, { id: "sess_issue" }],
    chatThreads: [{ id: "sess_chat" }],
  });

  assert.equal(
    resolveLoadedChatSelection(selection, "sess_issue"),
    "sess_issue",
  );
});

const { loadedChatSelection, resolveChatSelection } =
  await import("../src/app/loaded-foundry-data.ts");

function session(id, source, extra = {}) {
  return { id, threadId: id, source, workspaceId: "ws_1", ...extra };
}

const foundryData = {
  agentSessions: [
    session("sess_chat", "chat"),
    session("sess_verifier", "verification", { parentSessionId: "sess_chat" }),
    session("sess_child", "agent", { parentSessionId: "sess_chat" }),
    session("sess_issue", "issue", {
      issueId: "iss_1",
      role: "issue_execution",
    }),
  ],
  chats: [],
};

test("a load lists chats and what agents started, and selects any session", () => {
  const selection = loadedChatSelection(foundryData);
  assert.deepEqual(selection.chatThreads.map((thread) => thread.id).sort(), [
    "sess_chat",
    "sess_child",
    "sess_verifier",
  ]);
  for (const id of ["sess_verifier", "sess_child", "sess_issue"]) {
    assert.equal(resolveLoadedChatSelection(selection, id), id);
  }
});

const newestListed = firstLoadedChatId(loadedChatSelection(foundryData));

function atPath(t, pathname) {
  const previousWindow = globalThis.window;
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  globalThis.window = { location: { pathname, search: "", hash: "" } };
}

test("a read keeps the chat the address names though it does not list it", (t) => {
  atPath(t, "/chats/sess_older");
  // Older than the list reaches, in another workspace, or gone: the chat
  // view looks it up and explains, never opening another chat instead.
  assert.equal(
    resolveChatSelection(foundryData, "sess_older", {
      keepRouteChat: true,
      respectChatRoute: true,
    }),
    "sess_older",
  );
  // A chat removed while shown is still replaced, by the newest listed.
  assert.equal(
    resolveChatSelection(foundryData, "sess_older", { respectChatRoute: true }),
    newestListed,
  );
});

test("a read keeps no chat selected on the bare chat list", (t) => {
  atPath(t, "/chats");
  assert.equal(
    resolveChatSelection(foundryData, "sess_chat", {
      keepRouteChat: true,
      respectChatRoute: true,
    }),
    "",
  );
});

test("a read off the chat route falls back as before", (t) => {
  atPath(t, "/workspace");
  assert.equal(
    resolveChatSelection(foundryData, "sess_older", {
      keepRouteChat: true,
      respectChatRoute: true,
    }),
    newestListed,
  );
});
