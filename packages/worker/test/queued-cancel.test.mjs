import assert from "node:assert/strict";
import test from "node:test";
import { cancelActiveSession } from "../dist/session-helpers.js";
import {
  dispatchKey,
  queuedSessionCancelRequests,
} from "../dist/session-state.js";

test("a cancel that arrives before its input starts stops only that input", async () => {
  queuedSessionCancelRequests.clear();
  await cancelActiveSession("sess_orphan", "input_stale");
  assert.equal(
    queuedSessionCancelRequests.has(dispatchKey("sess_orphan", "input_stale")),
    true,
  );
  assert.equal(
    queuedSessionCancelRequests.has(dispatchKey("sess_orphan", "input_next")),
    false,
    "the session's next input must still run",
  );
  queuedSessionCancelRequests.clear();
});
