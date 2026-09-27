import assert from "node:assert/strict";
import test from "node:test";

// Stack selection is read when the modules load, as in a real service.
process.env.FOUNDRY_STACK = "dev";
const { serviceEnvironment, serviceLabel, watchdogLabel } =
  await import("../dist/service.js");

test("a named stack's service runs as that stack and names itself after it", () => {
  assert.equal(serviceEnvironment().FOUNDRY_STACK, "dev");
  assert.equal(serviceLabel(), "dev.foundry.dev.worker");
  assert.equal(watchdogLabel(), "dev.foundry.dev.worker-watchdog");
});
