import assert from "node:assert/strict";
import test from "node:test";
import {
  chatIsUnread,
  chatListStatus,
  threadAnswerRevision,
} from "../src/features/chat/chat-list-state.ts";

test("unread tracks completed answer identities, not activity labels", () => {
  assert.equal(chatIsUnread(undefined, ""), false);
  assert.equal(chatIsUnread(undefined, "answer-1"), true);
  assert.equal(chatIsUnread({ revision: "answer-1" }, "answer-1"), false);
  assert.equal(chatIsUnread({ revision: "answer-1" }, "answer-2"), true);
  assert.equal(
    chatIsUnread({ revision: "answer-1", forced: true }, "answer-1"),
    true,
  );
  assert.equal(
    threadAnswerRevision([
      { id: "one", status: "completed", answerRevision: "one:done" },
      { id: "two", status: "running", updatedLabel: "now" },
    ]),
    "one:done",
  );
});
test("row uses one status with processing, failure, and unread precedence", () => {
  assert.equal(chatListStatus(true, true, true), "processing");
  assert.equal(chatListStatus(false, true, true), "failed");
  assert.equal(chatListStatus(false, false, true), "unread");
  assert.equal(chatListStatus(false, false, false), "idle");
});
