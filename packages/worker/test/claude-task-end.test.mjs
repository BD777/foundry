import assert from "node:assert/strict";
import test from "node:test";
import { claudeProcessEvent } from "../dist/session/runner/sdk-messages.js";

// A task's end carries how it ended natively and, for a background
// command, its exit code: the server records them on its work even after
// the inventory dropped the task.
test("a task's end reports its native status and exit code", () => {
  const end = (status, summary) =>
    claudeProcessEvent({
      type: "system",
      subtype: "task_notification",
      task_id: "bcmd",
      status,
      summary,
    });
  const completed = end(
    "completed",
    'Background command "Build" completed (exit code 0)',
  );
  assert.equal(completed?.label, "Subtask completed");
  assert.equal(completed?.metadata?.taskStatus, "completed");
  assert.equal(completed?.metadata?.exitCode, 0);
  const failed = end(
    "failed",
    'Background command "Build" failed with exit code 2',
  );
  assert.equal(failed?.label, "Subtask failed");
  assert.equal(failed?.metadata?.taskStatus, "failed");
  assert.equal(failed?.metadata?.exitCode, 2);
  const stopped = end("stopped", "Build");
  assert.equal(stopped?.label, "Subtask failed");
  assert.equal(stopped?.metadata?.taskStatus, "stopped");
  assert.equal(stopped?.metadata?.exitCode, undefined);
});
