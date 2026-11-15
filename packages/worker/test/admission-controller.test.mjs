import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AdaptiveConcurrencyController } from "../dist/concurrency/admission-controller.js";
import { ConcurrentTaskScheduler } from "../dist/platform/task-scheduler.js";
import { TurnUsageSampler } from "../dist/concurrency/turn-usage-sampler.js";

const GiB = 1024 ** 3;

test("the controller puts hard hold on the scheduler and releases queued work", async () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-admission-controller-"));
  let available = 100 * 1024 ** 2;
  const scheduler = new ConcurrentTaskScheduler(2);
  const controller = new AdaptiveConcurrencyController(scheduler, {
    estimator: new TurnUsageSampler(join(root, "estimates.json")),
    readSettings: () => ({
      activeRuntimeTtlMs: 60_000,
      mode: "adaptive",
    }),
    readSignals: () => ({
      capturedAt: new Date().toISOString(),
      cpuCount: 4,
      cpuPressurePercent: 10,
      memoryAvailableBytes: available,
      memoryTotalBytes: 8 * GiB,
    }),
  });
  try {
    const held = controller.tick();
    assert.equal(held.hardHold, true);
    assert.equal(scheduler.load().hardHold, true);

    let ran = false;
    const run = scheduler.schedule(
      "chat:a",
      () => {
        ran = true;
      },
      undefined,
      { sessionId: "sess_a", workspaceId: "ws_a", runtime: "claude" },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ran, false);

    available = 5 * GiB;
    const released = controller.tick();
    assert.equal(released.hardHold, false);
    await run;
    assert.equal(ran, true);
  } finally {
    controller.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime state reports whole byte counts: the server reads them as integers", () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-admission-controller-"));
  const estimator = new TurnUsageSampler(join(root, "estimates.json"));
  const original = estimator.reportedEstimates.bind(estimator);
  estimator.reportedEstimates = (estimates) =>
    original(estimates).map((estimate) => ({
      ...estimate,
      typicalRssBytes: 262288354.26635045,
      peakRssBytes: 379289600.5,
    }));
  const scheduler = new ConcurrentTaskScheduler(2);
  void scheduler.schedule("chat:a", () => new Promise(() => {}), undefined, {
    sessionId: "sess_a",
    workspaceId: "ws_a",
    runtime: "claude",
  });
  const controller = new AdaptiveConcurrencyController(scheduler, {
    estimator,
    readSettings: () => ({ activeRuntimeTtlMs: 60_000, mode: "adaptive" }),
    readSignals: () => ({
      capturedAt: new Date().toISOString(),
      cpuCount: 4,
      memoryAvailableBytes: 5.5 * GiB + 0.25,
      memoryTotalBytes: 8 * GiB,
      swapFreeBytes: 1024.75,
    }),
  });
  try {
    const state = controller.tick();
    assert.ok(state.estimates.length > 0);
    for (const estimate of state.estimates) {
      assert.ok(Number.isInteger(estimate.typicalRssBytes));
      assert.ok(Number.isInteger(estimate.peakRssBytes));
    }
    assert.ok(Number.isInteger(state.signals.memoryAvailableBytes));
    assert.ok(Number.isInteger(state.signals.swapFreeBytes));
  } finally {
    controller.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
