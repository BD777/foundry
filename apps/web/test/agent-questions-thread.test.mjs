// A Codex async question keeps its structure from the session's events to
// the chat's rows, naming the native item an answer refers to (DEV-063).
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register("./bundler-resolve.mjs", import.meta.url);
const { chatMessagesForThread } =
  await import("../src/features/chat/chat-model.ts");

const at = (second) =>
  new Date(Date.UTC(2026, 9, 28, 8, 0, second)).toISOString();

test("a question answer row carries its questions and native item id", () => {
  const questions = [
    { title: "Which language?", options: ["English", "Chinese"] },
  ];
  const messages = chatMessagesForThread({
    id: "t",
    sessions: [
      {
        id: "s",
        provider: "codex",
        prompt: "Ask me",
        status: "running",
        events: [
          {
            id: "evt_in",
            at: at(1),
            label: "User message",
            detail: "",
            level: "info",
            sessionId: "s",
            message: { id: "in_1", kind: "user", text: "Ask me" },
          },
          {
            id: "evt_q",
            at: at(2),
            label: "Response stream",
            detail: "Which language?\n- English\n- Chinese",
            level: "info",
            sessionId: "s",
            message: {
              id: "in_1/call_7",
              kind: "assistant",
              text: "Which language?\n- English\n- Chinese",
              questions,
              delivery: "async",
            },
          },
        ],
      },
    ],
  });
  const asked = messages.find((message) => message.questions);
  assert.ok(asked, "the question row");
  assert.deepEqual(asked.questions, questions);
  assert.equal(asked.questionItemId, "call_7");
});
