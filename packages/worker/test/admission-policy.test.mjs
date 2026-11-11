import assert from "node:assert/strict";
import test from "node:test";
import {
  admissionThresholds,
  adaptiveConcurrencyFloor,
  decideAdmission,
} from "../dist/concurrency/admission-policy.js";
import {
  parseSwapFree,
  parseVmSwapFree,
} from "../dist/concurrency/resource-signals.js";

const GiB = 1024 ** 3;
const estimate = {
  workspaceId: "ws_a",
  runtime: "claude",
  source: "observed",
  typicalRssBytes: 400 * 1024 ** 2,
  peakRssBytes: 1.5 * GiB,
  averageCpuCores: 0.3,
};

function decide(overrides = {}) {
  return decideAdmission({
    estimates: [estimate],
    now: 0,
    previous: {},
    queued: 0,
    running: [],
    settings: { mode: "adaptive" },
    signals: {
      capturedAt: new Date(0).toISOString(),
      cpuCount: 4,
      cpuPressurePercent: 20,
      memoryAvailableBytes: 5 * GiB,
      memoryTotalBytes: 8 * GiB,
    },
    ...overrides,
  });
}

test("typical RSS and swap headroom pick the adaptive target", () => {
  const decision = decide({
    running: [
      {
        workspaceId: "ws_a",
        runtime: "claude",
        currentRssBytes: GiB,
        currentCpuCores: 0.2,
      },
    ],
    signals: {
      capturedAt: new Date(0).toISOString(),
      cpuCount: 4,
      cpuPressurePercent: 20,
      memoryAvailableBytes: 5 * GiB,
      memoryTotalBytes: 8 * GiB,
      swapFreeBytes: 2 * GiB,
    },
  });
  assert.equal(decision.limit, 16);
  assert.equal(decision.state.target, 16);
  assert.equal(decision.state.cpuOffset, 0);
  assert.ok(decision.reasons.includes("memory_limit"));
  assert.equal(decision.hardHold, false);
});

test("steady PSI at 45% keeps the full memory target", () => {
  let previous = {};
  let now = 0;
  for (let step = 0; step < 4; step++) {
    const decision = decide({
      now,
      previous,
      running: [
        {
          workspaceId: "ws_a",
          runtime: "claude",
          currentRssBytes: GiB,
          currentCpuCores: 0.2,
        },
      ],
      signals: {
        capturedAt: new Date(now).toISOString(),
        cpuCount: 4,
        cpuPressurePercent: 45,
        memoryAvailableBytes: 5 * GiB,
        memoryTotalBytes: 8 * GiB,
      },
    });
    assert.equal(decision.limit, 12);
    assert.equal(decision.state.cpuOffset, 0);
    previous = decision.state;
    now += admissionThresholds.pressureSustainMs;
  }
});

test("target selection is table-driven", () => {
  const cases = [
    {
      name: "observed typical RSS",
      estimates: [estimate],
      running: [
        {
          workspaceId: "ws_a",
          runtime: "claude",
          currentRssBytes: GiB,
          currentCpuCores: 0.2,
        },
      ],
      signals: {
        capturedAt: new Date(0).toISOString(),
        cpuCount: 4,
        cpuPressurePercent: 45,
        memoryAvailableBytes: 5 * GiB,
        memoryTotalBytes: 8 * GiB,
      },
      limit: 12,
    },
    {
      name: "cold start with six queued",
      estimates: [],
      queued: 6,
      signals: {
        capturedAt: new Date(0).toISOString(),
        cpuCount: 3,
        cpuPressurePercent: 45,
      },
      limit: 6,
    },
    {
      name: "no memory signal uses the parallel floor",
      estimates: [],
      signals: {
        capturedAt: new Date(0).toISOString(),
        cpuPressurePercent: 20,
      },
      limit: 4,
    },
    {
      name: "2 cores, 7.5 GiB, 1 GiB RAM and 4 GiB swap stay parallel",
      estimates: [],
      signals: {
        capturedAt: new Date(0).toISOString(),
        cpuCount: 2,
        cpuPressurePercent: 100,
        memoryAvailableBytes: GiB,
        memoryTotalBytes: 7.5 * GiB,
        swapFreeBytes: 4 * GiB,
      },
      limit: 10,
    },
    {
      name: "2 GiB device still starts at least four turns",
      estimates: [],
      signals: {
        capturedAt: new Date(0).toISOString(),
        cpuCount: 2,
        cpuPressurePercent: 20,
        memoryAvailableBytes: GiB,
        memoryTotalBytes: 2 * GiB,
        swapFreeBytes: 0,
      },
      limit: 4,
    },
  ];
  for (const testCase of cases) {
    const decision = decide(testCase);
    assert.equal(decision.limit, testCase.limit, testCase.name);
    assert.equal(decision.state.cpuOffset, 0, testCase.name);
  }
});

test("the adaptive parallel floor is never below four", () => {
  assert.equal(adaptiveConcurrencyFloor(undefined), 4);
  assert.equal(adaptiveConcurrencyFloor(1), 4);
  assert.equal(adaptiveConcurrencyFloor(2), 4);
  assert.equal(adaptiveConcurrencyFloor(3), 6);
  assert.equal(adaptiveConcurrencyFloor(20), 16);
});

test("sustained 70% pressure steps down and 50% steps back to the target", () => {
  let now = 0;
  let previous = {};
  const limits = [];
  for (let step = 0; step < 6; step++) {
    const decision = decide({
      now,
      previous,
      signals: {
        capturedAt: new Date(now).toISOString(),
        cpuCount: 4,
        cpuPressurePercent: 70,
        memoryAvailableBytes: 5 * GiB,
        memoryTotalBytes: 8 * GiB,
      },
    });
    limits.push(decision.limit);
    previous = decision.state;
    now += admissionThresholds.pressureSustainMs;
  }
  assert.deepEqual(limits.slice(0, 3), [10, 9, 8]);
  assert.equal(limits.at(-1), 8);
  assert.ok(previous.cpuOffset < 0);

  const recovered = [];
  for (let step = 0; step < 8; step++) {
    const decision = decide({
      now,
      previous,
      signals: {
        capturedAt: new Date(now).toISOString(),
        cpuCount: 4,
        cpuPressurePercent: 50,
        memoryAvailableBytes: 5 * GiB,
        memoryTotalBytes: 8 * GiB,
      },
    });
    recovered.push(decision.limit);
    previous = decision.state;
    now += admissionThresholds.pressureSustainMs;
  }
  assert.equal(recovered.at(-1), 10);
  assert.equal(previous.cpuOffset, 0);
});

test("sustained CPU pressure cannot reduce concurrency below the floor", () => {
  let now = 0;
  let previous = {};
  for (let step = 0; step < 20; step++) {
    const decision = decide({
      now,
      previous,
      estimates: [],
      signals: {
        capturedAt: new Date(now).toISOString(),
        cpuCount: 2,
        cpuPressurePercent: 100,
        memoryAvailableBytes: GiB,
        memoryTotalBytes: 7.5 * GiB,
        swapFreeBytes: 4 * GiB,
      },
    });
    assert.ok(decision.limit >= 4);
    previous = decision.state;
    now += admissionThresholds.pressureSustainMs;
  }
  assert.equal(previous.limit, 4);
  assert.equal(previous.cpuOffset, 4 - previous.target);
});

test("a cold start with six queued turns starts at the parallel floor", () => {
  const decision = decide({
    estimates: [],
    queued: 6,
    signals: {
      capturedAt: new Date(0).toISOString(),
      cpuCount: 3,
      cpuPressurePercent: 45,
      memoryAvailableBytes: undefined,
      memoryTotalBytes: 8 * GiB,
    },
  });
  assert.equal(decision.limit, 6);
  assert.equal(decision.state.cpuOffset, 0);
  assert.ok(decision.reasons.includes("parallel_floor"));
});

test("without memory samples the typical prior still stays above the floor", () => {
  const decision = decide({
    estimates: [],
    signals: {
      capturedAt: new Date(0).toISOString(),
      cpuCount: 2,
      cpuPressurePercent: 20,
      memoryAvailableBytes: 5 * GiB,
      memoryTotalBytes: 8 * GiB,
    },
  });
  assert.equal(decision.limit, 10);
  assert.ok(decision.reasons.includes("estimate_prior"));
  assert.equal(
    decide({
      estimates: [],
      signals: {
        capturedAt: new Date(0).toISOString(),
        cpuPressurePercent: 20,
      },
    }).limit,
    4,
  );
});

test("low available RAM and swap is a hard hold for both modes", () => {
  for (const settings of [
    { mode: "adaptive" },
    { mode: "forced", forcedLimit: 12 },
  ]) {
    const decision = decide({
      settings,
      signals: {
        capturedAt: new Date(0).toISOString(),
        memoryAvailableBytes: 200 * 1024 ** 2,
        memoryTotalBytes: 8 * GiB,
        swapFreeBytes: 200 * 1024 ** 2,
      },
    });
    assert.equal(decision.hardHold, true);
    assert.ok(decision.reasons.includes("memory_hard_hold"));
  }
});

test("available swap prevents a hard hold", () => {
  const decision = decide({
    signals: {
      capturedAt: new Date(0).toISOString(),
      cpuCount: 2,
      memoryAvailableBytes: 300 * 1024 ** 2,
      memoryTotalBytes: 8 * GiB,
      swapFreeBytes: GiB,
    },
  });
  assert.equal(decision.hardHold, false);
  assert.equal(decision.limit, 4);
});

test("forced mode ignores target and CPU offset but keeps the hard hold", () => {
  const forced = decide({
    previous: { cpuOffset: -2 },
    settings: { mode: "forced", forcedLimit: 12 },
    signals: {
      capturedAt: new Date(0).toISOString(),
      cpuPressurePercent: 95,
      memoryAvailableBytes: 700 * 1024 ** 2,
      memoryTotalBytes: 8 * GiB,
    },
  });
  assert.equal(forced.limit, 12);
  assert.equal(forced.hardHold, false);
  assert.ok(forced.reasons.includes("forced_mode"));
  assert.equal(forced.reasons.includes("cpu_pressure_high"), false);
  assert.equal(forced.state.cpuOffset, undefined);
});

test("adaptive and forced limits stay within their bounds", () => {
  assert.equal(
    decide({
      previous: { cpuOffset: -20 },
      signals: {
        capturedAt: new Date(0).toISOString(),
        cpuCount: 2,
        cpuPressurePercent: 20,
        memoryAvailableBytes: undefined,
      },
    }).limit,
    4,
  );
  assert.equal(
    decide({
      settings: { mode: "forced", forcedLimit: 99 },
    }).limit,
    16,
  );
});

test("Linux and macOS swap parsers report bytes", () => {
  assert.equal(parseSwapFree("SwapFree: 1048576 kB\n"), GiB);
  assert.equal(
    parseVmSwapFree("total = 4.00G used = 1.00G free = 3.00G"),
    3 * GiB,
  );
});
