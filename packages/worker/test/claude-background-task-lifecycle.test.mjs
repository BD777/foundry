import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleActiveClaudeMessage } from "../dist/runner.js";

function assistant(text) {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

function result(text) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
  };
}

test("keeps a Foundry turn open until background tasks settle and Claude responds again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-claude-tasks-"));
  const messagesPath = join(directory, "messages.jsonl");
  const resultPath = join(directory, "result.md");
  writeFileSync(messagesPath, "");
  const events = [];
  let resolved;
  let watchdogClosed = false;
  const turn = {
    emit: async (label, detail) => events.push({ detail, label }),
    finalResult: "",
    messagesPath,
    nativeSessionId: "native_test",
    openTaskIds: new Set(),
    partialResult: "",
    reject: (error) => {
      throw error;
    },
    resolve: (value) => {
      resolved = value;
    },
    resultPath,
    watchdog: {
      close: () => {
        watchdogClosed = true;
      },
      touch: () => undefined,
    },
  };
  const runtime = {
    closed: false,
    input: { close: () => undefined },
    key: "runtime_test",
    lastUsed: 0,
    nativeSessionId: "native_test",
    pending: turn,
  };

  try {
    await handleActiveClaudeMessage(runtime, {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        { task_id: "task_a", task_type: "local_agent" },
        { task_id: "task_b", task_type: "local_agent" },
      ],
    });
    await handleActiveClaudeMessage(runtime, {
      type: "system",
      subtype: "task_started",
      task_id: "task_a",
      task_type: "local_agent",
    });
    await handleActiveClaudeMessage(runtime, {
      type: "system",
      subtype: "task_started",
      task_id: "task_b",
      task_type: "local_agent",
    });
    await handleActiveClaudeMessage(
      runtime,
      assistant("Both agents are running."),
    );
    await handleActiveClaudeMessage(
      runtime,
      result("Both agents are running."),
    );

    assert.equal(runtime.pending, turn);
    assert.equal(resolved, undefined);
    assert.equal(existsSync(resultPath), false);
    assert.deepEqual([...turn.openTaskIds].sort(), ["task_a", "task_b"]);
    assert.equal(
      turn.finalResult,
      "",
      "the continuation needs a fresh text buffer",
    );

    await handleActiveClaudeMessage(runtime, {
      type: "system",
      subtype: "task_notification",
      task_id: "task_a",
      status: "completed",
      summary: "A completed",
    });
    await handleActiveClaudeMessage(
      runtime,
      assistant("A is done; B is running."),
    );
    await handleActiveClaudeMessage(
      runtime,
      result("A is done; B is running."),
    );

    assert.equal(runtime.pending, turn);
    assert.deepEqual([...turn.openTaskIds], ["task_b"]);

    await handleActiveClaudeMessage(runtime, {
      type: "system",
      subtype: "task_notification",
      task_id: "task_b",
      status: "completed",
      summary: "B completed",
    });
    await handleActiveClaudeMessage(runtime, assistant("Final synthesis."));
    await handleActiveClaudeMessage(runtime, result("Final synthesis."));

    assert.equal(runtime.pending, undefined);
    assert.deepEqual(resolved, {
      nativeSessionId: "native_test",
      response: "Final synthesis.",
    });
    assert.equal(readFileSync(resultPath, "utf8"), "Final synthesis.\n");
    assert.equal(watchdogClosed, true);
    assert.equal(
      events.filter(({ label }) => label === "等待后台任务").length,
      2,
    );
    assert.equal(
      events.filter(({ label }) => label === "Claude Agent SDK finished")
        .length,
      1,
    );

    const persisted = readFileSync(messagesPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      persisted.filter(
        (message) =>
          message.type === "system" && message.subtype === "task_notification",
      ).length,
      2,
      "notifications after the first result must remain in the Foundry transcript",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
