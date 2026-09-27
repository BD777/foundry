import assert from "node:assert/strict";
import test from "node:test";
import { claudeTaskNotificationBookkeeping } from "../dist/sdk-messages.js";

test("a task notification result that ran no model turn answers no input", () => {
  const stale = {
    type: "result",
    subtype: "success",
    result: "",
    num_turns: 0,
    origin: { kind: "task-notification" },
  };
  assert.equal(claudeTaskNotificationBookkeeping(stale), true);
  // A continuation after a background task ran the model: it can be the answer.
  assert.equal(
    claudeTaskNotificationBookkeeping({ ...stale, num_turns: 1 }),
    false,
  );
  assert.equal(
    claudeTaskNotificationBookkeeping({ ...stale, origin: { kind: "human" } }),
    false,
  );
  assert.equal(claudeTaskNotificationBookkeeping({ type: "assistant" }), false);
});
