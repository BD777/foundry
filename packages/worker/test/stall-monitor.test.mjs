import assert from "node:assert/strict";
import test from "node:test";
import {
  beginActivity,
  recordTick,
  startStallMonitor,
  takeStalls,
  withStalls,
} from "../dist/stall-monitor.js";

test("a late tick is recorded with the activities running then", () => {
  takeStalls();
  recordTick(1_000);
  const end = beginActivity("skill scan reply");
  // An activity that ends before the late tick is still named.
  const quick = beginActivity("registration");
  quick();
  recordTick(2_500); // 0.5s late: not a stall
  assert.deepEqual(takeStalls(), []);
  recordTick(9_500); // due at 3.5s: 6s late
  end();
  const [stall] = takeStalls();
  assert.equal(stall.lagMs, 6_000);
  assert.deepEqual(stall.activities, ["skill scan reply"]);
  assert.equal(new Date(stall.at).getTime(), 9_500);
});

test("a registration carries recorded stalls once", () => {
  takeStalls();
  recordTick(10_000);
  recordTick(17_000);
  const first = withStalls({ device: { id: "dev" } });
  assert.equal(first.stalls?.length, 1);
  assert.equal(first.stalls[0].lagMs, 6_000);
  const second = withStalls({ device: { id: "dev" } });
  assert.equal("stalls" in second, false, "the same stall is reported once");
});

test("the running monitor notices a blocked event loop", async () => {
  takeStalls();
  startStallMonitor();
  // Let the monitor take its first measurement.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const end = beginActivity("busy loop");
  const until = Date.now() + 6_000;
  while (Date.now() < until) {
    // Block the event loop the way a synchronous step would.
  }
  end();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const stalls = takeStalls();
  assert.equal(stalls.length, 1);
  assert.ok(stalls[0].lagMs >= 5_000, `lag ${stalls[0].lagMs}`);
  assert.deepEqual(stalls[0].activities, ["busy loop"]);
});
