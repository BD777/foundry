import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleActiveClaudeMessage } from "../dist/session/runner/claude-messages.js";
import {
  claudeProcessEvent,
  claudeQuotaExhaustion,
} from "../dist/session/runner/sdk-messages.js";

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
    liveness: {
      observe: () => {
        touches++;
        return [];
      },
      close: () => undefined,
    },
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
        label: "Rate limited, waiting to retry",
        detail: "HTTP 429 · Retry 3/10 · continuing in 30s",
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
    label: "Model request retry",
    detail: "Model request did not succeed yet · Retrying",
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
    "HTTP 503 · Retry 1 · continuing in 2s",
  );
});

test("Claude quota exhaustion stops before another SDK retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-claude-quota-"));
  const events = [];
  const rejections = [];
  let closedQuery = 0;
  const turn = {
    emit: async (label, detail, level) => events.push({ label, detail, level }),
    finalResult: "",
    partialResult: "",
    openTaskIds: new Set(),
    messagesPath: join(directory, "messages.jsonl"),
    resultPath: join(directory, "result.md"),
    reject: (error) => rejections.push(error),
    resolve: () => undefined,
    liveness: { observe: () => [], close: () => undefined },
  };
  const runtime = {
    closed: false,
    key: "quota_test",
    lastUsed: 0,
    nativeSessionId: "native_quota",
    foundrySessionId: "sess_quota",
    pending: turn,
    input: { close: () => undefined },
    query: { close: () => closedQuery++ },
    background: { close: () => undefined },
    questions: { close: () => undefined },
    timers: { close: () => [], announcedFire: () => undefined },
  };
  try {
    await handleActiveClaudeMessage(runtime, {
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 1000,
      error_status: 429,
      error: "billing_error",
    });
    assert.equal(runtime.closed, true);
    assert.equal(runtime.pending, undefined);
    assert.equal(closedQuery, 1);
    assert.equal(events.length, 0, "quota rejection is not a rate-limit retry");
    assert.equal(rejections.length, 1);
    assert.match(rejections[0].message, /quota or billing limit is exhausted/);

    await handleActiveClaudeMessage(runtime, {
      type: "assistant",
      is_api_error_message: true,
      error: "billing_error",
      message: {
        content: [
          {
            type: "text",
            text: "API Error: Request rejected (429) · upstream account quota usage limit has been reached",
          },
        ],
      },
    });
    assert.equal(
      rejections.length,
      1,
      "the closed runtime ignores queued frames",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Claude quota detection uses the structured billing code before text", () => {
  assert.match(
    claudeQuotaExhaustion({
      type: "assistant",
      is_api_error_message: true,
      error: "billing_error",
      message: {
        content: [{ type: "text", text: "Request rejected" }],
      },
    }),
    /quota or billing limit is exhausted/,
  );
  assert.equal(
    claudeQuotaExhaustion({
      type: "system",
      subtype: "api_retry",
      error_status: 429,
      error: "rate_limit",
    }),
    undefined,
  );
});
