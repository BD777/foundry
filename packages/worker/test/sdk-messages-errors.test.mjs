import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeAgentResultError,
  claudeApiErrorMessage,
  claudeProcessEvent,
} from "../dist/sdk-messages.js";

const syntheticAssistant = (text, code, opts = {}) => ({
  type: "assistant",
  is_api_error_message: true,
  error: code,
  session_id: "native-1",
  message: {
    model: "<synthetic>",
    role: "assistant",
    stop_reason: "stop_sequence",
    stop_sequence: "",
    usage: {},
    content: [{ type: "text", text }],
  },
  ...opts,
});

const failedResult = (text, terminalReason, resultOpts = {}) => ({
  type: "result",
  subtype: "success",
  is_error: true,
  stop_reason: "stop_sequence",
  terminal_reason: terminalReason,
  result: text,
  ...resultOpts,
});

test("synthetic pre-turn API errors are recognized with their provider text and code", () => {
  const message = syntheticAssistant(
    "Failed to authenticate. API Error: 401 The authentication credential is invalid; sign in again or check the API key",
    "authentication_failed",
  );
  const parsed = claudeApiErrorMessage(message);
  assert.equal(parsed.code, "authentication_failed");
  assert.match(parsed.text, /401/);

  const event = claudeProcessEvent(message);
  assert.equal(event.label, "执行失败");
  assert.equal(event.level, "error");
  assert.match(event.detail, /401/);

  // The camelCase transcript spelling is accepted too.
  const camel = syntheticAssistant("Prompt is too long", "invalid_request", {
    is_api_error_message: undefined,
    isApiErrorMessage: true,
  });
  delete camel.is_api_error_message;
  assert.match(claudeApiErrorMessage(camel).text, /Prompt is too long/);
});

test("failed result surfaces the provider text instead of the stop_reason placeholder", () => {
  const auth = failedResult(
    "Failed to authenticate. API Error: 401 The authentication credential is invalid; sign in again or check the API key",
    "api_error",
  );
  const authError = claudeAgentResultError(auth);
  assert.match(authError.message, /401/);
  assert.doesNotMatch(authError.message, /^stop_sequence$/);

  const tooLong = failedResult("Prompt is too long", "blocking_limit");
  assert.equal(claudeAgentResultError(tooLong).message, "Prompt is too long");

  const event = claudeProcessEvent(tooLong);
  assert.equal(event.level, "error");
  assert.equal(event.detail, "Prompt is too long");
});

test("explicit errors array still wins; terminal reason is a fallback only when text is absent", () => {
  const withErrors = failedResult("Prompt is too long", "blocking_limit", {
    errors: ["explicit backend failure"],
  });
  assert.equal(
    claudeAgentResultError(withErrors).message,
    "explicit backend failure",
  );

  const noText = failedResult("", "blocking_limit");
  assert.match(claudeAgentResultError(noText).message, /context limit/);
});

test("successful results and ordinary assistants are not classified as API errors", () => {
  assert.equal(
    claudeApiErrorMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    }),
    undefined,
  );
  assert.equal(
    claudeAgentResultError({ type: "result", is_error: false, result: "done" }),
    undefined,
  );
});
