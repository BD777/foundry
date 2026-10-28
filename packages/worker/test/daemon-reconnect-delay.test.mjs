import assert from "node:assert/strict";
import test from "node:test";
import { reconnectDelayMs } from "../dist/daemon-connection.js";

test("reconnect waits are spread around the backoff", () => {
  assert.equal(
    reconnectDelayMs(1000, () => 0),
    500,
  );
  assert.equal(
    reconnectDelayMs(1000, () => 0.5),
    1000,
  );
  assert.equal(
    reconnectDelayMs(1000, () => 0.999),
    1499,
  );
  // The top of the spread stays below one and a half times the backoff.
  assert.equal(
    reconnectDelayMs(1000, () => 0.9999),
    1499,
  );
  const waits = new Set(
    Array.from({ length: 50 }, () => reconnectDelayMs(1000)),
  );
  assert.ok(
    waits.size > 10,
    "devices reconnecting together pick different waits",
  );
  for (const wait of waits) assert.ok(wait >= 500 && wait < 1500);
});
