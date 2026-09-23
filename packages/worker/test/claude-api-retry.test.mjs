import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleActiveClaudeMessage } from "../dist/runner.js";
import { claudeProcessEvent } from "../dist/sdk-messages.js";

test("Claude API throttling is visible without finishing the active run or leaking diagnostics", async () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-claude-retry-"));
  const events = [];
  let resolved;
  let touches = 0;
  const turn = {
    emit: async (label, detail, level) => events.push({ label, detail, level }),
    finalResult: "",
    partialResult: "",
    openTaskIds: new Set(),
    messagesPath: join(directory, "messages.jsonl"),
    resultPath: join(directory, "result.md"),
    reject: (error) => {
      throw error;
    },
    resolve: (result) => {
      resolved = result;
    },
    watchdog: { touch: () => touches++, close: () => undefined },
  };
  const runtime = {
    closed: false,
    key: "retry_test",
    lastUsed: 0,
    nativeSessionId: "native_retry",
    pending: turn,
    input: { close: () => undefined },
  };
  try {
    await handleActiveClaudeMessage(runtime, {
      type: "system",
      subtype: "api_retry",
      attempt: 3,
      max_retries: 10,
      retry_delay_ms: 30000,
      error_status: 429,
      error: "private proxy diagnostics must stay out of shared events",
      session_id: "native_retry",
    });
    assert.deepEqual(events, [
      {
        label: "模型限流，等待重试",
        detail: "HTTP 429；第 3/10 次重试；30 秒后继续",
        level: "warning",
      },
    ]);
    assert.equal(runtime.pending, turn);
    assert.equal(runtime.nativeSessionId, "native_retry");
    assert.equal(resolved, undefined);
    assert.equal(existsSync(turn.resultPath), false);
    assert.equal(touches, 1);
    await handleActiveClaudeMessage(runtime, {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Recovered after retry",
    });
    assert.equal(resolved.response, "Recovered after retry");
    assert.equal(resolved.nativeSessionId, "native_retry");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Claude retry events tolerate absent or invalid SDK metadata", () => {
  const event = claudeProcessEvent({
    type: "system",
    subtype: "api_retry",
    attempt: -1,
    max_retries: Infinity,
    retry_delay_ms: NaN,
    error_status: "private",
    error: "private",
  });
  assert.deepEqual(event, {
    label: "模型请求重试",
    detail: "模型请求暂未成功；正在重试",
    level: "warning",
  });
  assert.equal(
    claudeProcessEvent({
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      error_status: 503,
      retry_delay_ms: 1501,
    }).detail,
    "HTTP 503；第 1 次重试；2 秒后继续",
  );
});
