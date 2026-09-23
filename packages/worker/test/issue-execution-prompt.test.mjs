import test from "node:test";
import assert from "node:assert/strict";
import {
  confirmedExecutionPrompt,
  executionFeedback,
} from "../dist/issue-execution-prompt.js";

test("execution uses exact confirmed contract, not pre-confirmation holds or status questions", () => {
  const issue = {
    sourceInput: "Discuss first. Do not implement.",
    executionContract: {
      revision: 4,
      goal: { text: "Write WELCOME.md" },
      confirmation: { at: "2026-09-11T17:00:00Z" },
    },
    messages: [
      {
        id: "clarify_a",
        role: "user",
        text: "Do not implement",
        createdAt: "2026-09-11T16:00:00Z",
      },
      {
        id: "msg_old",
        role: "user",
        text: "Earlier revision feedback",
        createdAt: "2026-09-11T16:30:00Z",
      },
      {
        id: "clarify_b",
        role: "user",
        text: "Clarification history",
        createdAt: "2026-09-11T17:00:00Z",
      },
      {
        id: "status_question_a",
        role: "user",
        text: "What is the status?",
        createdAt: "2026-09-11T17:01:00Z",
      },
      {
        id: "msg_new",
        role: "user",
        text: "Fix the missing deliverable",
        createdAt: "2026-09-11T17:02:00Z",
      },
      {
        id: "reply",
        role: "assistant",
        text: "Summary",
        createdAt: "2026-09-11T17:03:00Z",
      },
    ],
  };
  assert.deepEqual(executionFeedback(issue), ["Fix the missing deliverable"]);
  const prompt = confirmedExecutionPrompt(issue);
  assert.match(prompt, /authorized implementation/);
  assert.match(prompt, /"revision":4/);
  assert.match(prompt, /Write WELCOME.md/);
  assert.doesNotMatch(prompt, /Discuss first/);
  assert.deepEqual(
    executionFeedback({ ...issue, executionContract: undefined }),
    [],
  );
});
