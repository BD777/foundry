import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./bundler-resolve.mjs", import.meta.url);
const { chatSendFailureMessage, toChatSendError } =
  await import("../src/features/chat/chat-send-error.ts");

const httpError = (status, message = "") => {
  const error = new Error(message);
  error.status = status;
  return error;
};

test("404 maps to agent/connection unavailable, not a raw body", () => {
  const message = chatSendFailureMessage(httpError(404, "not found"));
  assert.match(message, /no longer available/i);
  assert.match(message, /kept/i);
});

test("410 maps to device removed", () => {
  const message = chatSendFailureMessage(httpError(410, "device_removed"));
  assert.match(message, /device was removed/i);
});

test("409 distinguishes daemon offline, busy and generic conflicts", () => {
  assert.match(
    chatSendFailureMessage(httpError(409, "local daemon is not connected")),
    /daemon is not connected/i,
  );
  assert.match(
    chatSendFailureMessage(httpError(409, "device busy: run in progress")),
    /busy/i,
  );
  assert.match(
    chatSendFailureMessage(httpError(409, "some conflict")),
    /conflict/i,
  );
});

test("network failure maps to a reachability hint", () => {
  assert.match(
    chatSendFailureMessage(new TypeError("Failed to fetch")),
    /cannot reach/i,
  );
});

test("500 and arbitrary server text are never surfaced", () => {
  const secret = "500 internal: stack at /srv/secret.ts token=AKIA-PRIVATE";
  const message = chatSendFailureMessage(httpError(500, secret));
  assert.doesNotMatch(message, /secret\.ts/i);
  assert.doesNotMatch(message, /AKIA-PRIVATE/);
  assert.match(message, /could not be delivered/i);
  // A 400 with an ugly body collapses to the same generic copy.
  const badRequest = chatSendFailureMessage(
    httpError(400, "SQLITE_CONSTRAINT: internal detail"),
  );
  assert.doesNotMatch(badRequest, /SQLITE/i);
});

test("non-HTTP and non-Error reasons collapse to safe generic copy", () => {
  assert.match(chatSendFailureMessage("boom"), /could not be delivered/i);
  assert.match(chatSendFailureMessage(undefined), /could not be delivered/i);
});

test("toChatSendError always returns an Error with safe fixed copy", () => {
  const error = toChatSendError(httpError(404, "not found"));
  assert.ok(error instanceof Error);
  assert.equal(error.name, "ChatSendError");
  assert.match(error.message, /no longer available/i);

  const generic = toChatSendError(httpError(500, "stack trace xyz"));
  assert.ok(generic instanceof Error);
  assert.doesNotMatch(generic.message, /xyz/);
});
