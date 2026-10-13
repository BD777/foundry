import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelActiveSession,
  clearSessionControl,
  takeQueuedSessionCancel,
} from "../dist/session-control.js";

test("a cancel that arrives before its input starts stops only that input", async () => {
  clearSessionControl();
  await cancelActiveSession("sess_orphan", "input_stale");
  assert.equal(
    takeQueuedSessionCancel("sess_orphan", "input_next"),
    false,
    "the session's next input must still run",
  );
  assert.equal(takeQueuedSessionCancel("sess_orphan", "input_stale"), true);
  assert.equal(
    takeQueuedSessionCancel("sess_orphan", "input_stale"),
    false,
    "a parked cancel stops its input once",
  );
});
