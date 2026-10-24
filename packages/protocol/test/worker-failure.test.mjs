import test from "node:test";
import assert from "node:assert/strict";
import {
  diagnoseWorkerFailure,
  executionHostStoppedError,
  isWorkerFailure,
  isWorkerDiskObservation,
  workerFailurePolicies,
} from "../dist/index.js";

test("terminal failures distinguish device, provider and unknown, without guessing a restart cause", () => {
  for (const [error, code] of [
    [executionHostStoppedError, "execution_host_stopped"],
    ["ENOSPC: no space left on device, open '/tmp/outbox'", "disk_full"],
    [
      '{"error":{"message":"invalid_request_error: throttle by model gateway: user tpm rate limit exceeded"}}',
      "model_rate_limit",
    ],
    [
      "Workspace draft scan timed out; reduce the draft package size and retry.",
      "skill_preparation_timeout",
    ],
    ["Reached maximum number of turns (10)", "turn_limit"],
    ["socket closed unexpectedly", "unknown"],
    ["HTTP 429 from an unrelated service", "unknown"],
  ])
    assert.equal(diagnoseWorkerFailure(error).code, code);
  assert.equal(workerFailurePolicies.execution_host_stopped.location, "device");
  assert.equal(workerFailurePolicies.model_rate_limit.location, "provider");
});

test("future or malformed metadata falls back; prototype names are not valid codes", () => {
  for (const value of [
    null,
    { version: 2, code: "disk_full" },
    { version: 1, code: "constructor" },
    { version: 1, code: "disk_full", inputId: 5 },
  ])
    assert.equal(isWorkerFailure(value), false);
  assert.ok(
    isWorkerFailure({ version: 1, code: "disk_full", inputId: "input" }),
  );
});

test("only the specific worker inventory warning counts as a disk observation", () => {
  const warning = {
    label: "Notice",
    level: "warning",
    detail:
      "Codex 0.163.0 background inventory unavailable: Error: ENOSPC: no space left on device, write",
  };
  assert.ok(isWorkerDiskObservation(warning));
  assert.equal(
    isWorkerDiskObservation({ ...warning, label: "Ran command" }),
    false,
  );
  assert.equal(
    isWorkerDiskObservation({ ...warning, label: "Commentary" }),
    false,
  );
  assert.equal(
    isWorkerDiskObservation({ ...warning, detail: "An old log says ENOSPC" }),
    false,
  );
});
