import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// Registered before the dynamic import so the resolver covers the whole graph.
register("./bundler-resolve.mjs", import.meta.url);
const { firstLoadedChatId, resolveLoadedChatSelection } =
  await import("../src/app/chat-selection.ts");

function loaded(overrides = {}) {
  return {
    chatSessions: [],
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
    chatSessions: [{ id: "sess_1" }],
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
