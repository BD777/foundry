import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeTurnWatchdog } from "../dist/watchdog.js";

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

test("resets the Claude idle timeout when the SDK emits an event", async () => {
  const timedOut = [];
  const watchdog = new ClaudeTurnWatchdog(40, (kind) => {
    timedOut.push(kind);
  });

  await wait(25);
  watchdog.touch();
  await wait(25);
  assert.deepEqual(timedOut, []);

  await wait(35);
  assert.deepEqual(timedOut, ["idle"]);
});

test("watchdog can be closed without firing", async () => {
  const timedOut = [];
  const watchdog = new ClaudeTurnWatchdog(40, (kind) => {
    timedOut.push(kind);
  });

  watchdog.close();
  await wait(75);
  assert.deepEqual(timedOut, []);
});
