import assert from "node:assert/strict";
import test from "node:test";

const { chatsNeedingMe } =
  await import("../src/features/chat/list/chat-needs-me.ts");

const chat = (id, fields = {}) => ({ id, title: id, ...fields });

test("needs me: chats with open pending items, most first; unread or failed alone do not count", () => {
  const chats = [
    chat("idle"),
    chat("unread", { status: "unread" }),
    chat("one-pending", { pendingCount: 1, status: "unread" }),
    chat("failed", { status: "failed" }),
    chat("three-pending", { pendingCount: 3 }),
    chat("another-one", { pendingCount: 1 }),
  ];
  assert.deepEqual(
    chatsNeedingMe(chats).map((item) => item.id),
    ["three-pending", "one-pending", "another-one"],
  );
  assert.deepEqual(chatsNeedingMe([chat("idle")]), []);
});
