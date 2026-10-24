import test from "node:test";
import assert from "node:assert/strict";
import { reportWorkerFailure } from "../dist/worker-failure.js";
import { executionHostStoppedError } from "@bd777/foundry-protocol";
import { registerKnownSecret } from "../dist/secret-redaction.js";

test("failure reporting carries a turn-bound diagnosis before the backward-compatible terminal result", () => {
  const sent = [];
  const transport = { send: (type, payload) => sent.push({ type, payload }) };
  reportWorkerFailure(
    transport,
    { id: "sess_test", input: { id: "input_test" } },
    executionHostStoppedError,
  );
  assert.deepEqual(
    sent.map((e) => e.type),
    ["session_event", "session_completed"],
  );
  assert.deepEqual(sent[0].payload.event.metadata.workerFailure, {
    version: 1,
    code: "execution_host_stopped",
    inputId: "input_test",
  });
  assert.equal(sent[0].payload.event.level, "error");
  assert.equal(sent[1].payload.error, executionHostStoppedError);
  assert.equal(sent[1].payload.inputId, "input_test");
});

test("original errors are redacted in both event and completion; unknown causes stay unknown", () => {
  const secret = "worker-failure-test-private-secret-123456789";
  registerKnownSecret(secret);
  const sent = [];
  reportWorkerFailure(
    { send: (type, payload) => sent.push(payload) },
    { id: "s" },
    new Error(`unexpected ${secret}`),
  );
  assert.ok(!JSON.stringify(sent).includes(secret));
  assert.equal(sent[0].event.metadata.workerFailure.code, "unknown");
});
