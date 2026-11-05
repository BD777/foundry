// A Codex async question keeps its structure from the session's events to
// the chat's rows, naming the native item an answer refers to (DEV-063).
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register("./bundler-resolve.mjs", import.meta.url);
const { chatMessagesForThread } =
  await import("../src/features/chat/thread/chat-model.ts");

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

test("Claude's answer after its question is a row of its own, not a replacement", () => {
  const questions = [
    {
      title: "Which greeting?",
      options: ["Hello", "Bonjour"],
      unranked: true,
    },
  ];
  const event = (id, second, fields) => ({
    id,
    at: at(second),
    level: "info",
    sessionId: "s",
    detail: "",
    ...fields,
  });
  const messages = chatMessagesForThread({
    id: "t",
    sessions: [
      {
        id: "s",
        provider: "claude",
        prompt: "Write it",
        status: "running",
        events: [
          event("evt_in", 1, {
            label: "User message",
            message: { id: "in_1", kind: "user", text: "Write it" },
          }),
          event("evt_q", 2, {
            label: "Response stream",
            detail: "Which greeting?",
            message: {
              id: "toolu_1",
              kind: "assistant",
              text: "Which greeting?\n- Hello\n- Bonjour",
              questions,
            },
          }),
          // Unanswered in time: Claude's next request, then its text, which
          // streams as snapshots without a message of their own.
          event("evt_usage", 3, {
            label: "Model request usage",
            metadata: {
              requestUsage: {
                requestId: "req_2",
                inputTokens: 10,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 5,
              },
            },
          }),
          event("evt_text", 4, {
            label: "Response stream",
            detail: "I used Hello.",
          }),
        ],
      },
    ],
  });
  const asked = messages.find((message) => message.questions);
  assert.ok(asked, "the question row survives");
  assert.equal(asked.questionItemId, "toolu_1");
  assert.ok(
    messages.some(
      (message) => message.role === "bot" && message.text === "I used Hello.",
    ),
    "the answer row",
  );
});
