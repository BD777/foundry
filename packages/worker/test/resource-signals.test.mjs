import assert from "node:assert/strict";
import test from "node:test";
import {
  parseMemAvailable,
  parsePressure,
  parseVmStatAvailable,
  readResourceSignals,
} from "../dist/concurrency/resource-signals.js";

test("Linux /proc parsers read available memory and PSI avg10", () => {
  assert.equal(
    parseMemAvailable("MemTotal: 8000000 kB\nMemAvailable: 2097152 kB\n"),
    2 * 1024 ** 3,
  );
  assert.deepEqual(
    parsePressure(
      "some avg10=61.25 avg60=32.00 avg300=10.00 total=1\n" +
        "full avg10=12.50 avg60=8.00 avg300=2.00 total=1\n",
    ),
    { someAvg10: 61.25, fullAvg10: 12.5 },
  );
});

test("macOS vm_stat gives reusable pages and pressure", () => {
  const parsed = parseVmStatAvailable(
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n" +
      "Pages free:                               1000.\n" +
      "Pages inactive:                           500.\n" +
      "Pages speculative:                        100.\n",
  );
  assert.equal(parsed.pageSize, 16384);
  assert.equal(parsed.availableBytes, 1600 * 16384);
});

test("a Linux sample combines memory, PSI and load without throwing", () => {
  const files = new Map([
    ["/proc/meminfo", "MemAvailable: 3145728 kB\n"],
    ["/proc/pressure/cpu", "some avg10=71.00 avg60=20.00 avg300=5.00\n"],
    ["/proc/pressure/memory", "some avg10=20.00\nfull avg10=11.00\n"],
  ]);
  const sample = readResourceSignals({
    platform: "linux",
    cpuCount: 2,
    totalMemoryBytes: 8 * 1024 ** 3,
    loadAverage: () => [3.5, 2, 1],
    now: () => 1234,
    readText: (path) => files.get(path),
  });
  assert.deepEqual(sample, {
    capturedAt: new Date(1234).toISOString(),
    cpuCount: 2,
    cpuPressurePercent: 71,
    loadAverage1: 3.5,
    memoryAvailableBytes: 3 * 1024 ** 3,
    memoryPressurePercent: 11,
    memoryTotalBytes: 8 * 1024 ** 3,
  });
});

test("missing signals stay undefined", () => {
  const sample = readResourceSignals({
    platform: "linux",
    cpuCount: 2,
    totalMemoryBytes: 8 * 1024 ** 3,
    loadAverage: () => [0, 0, 0],
    now: () => 0,
    readText: () => undefined,
  });
  assert.equal(sample.memoryAvailableBytes, undefined);
  assert.equal(sample.memoryPressurePercent, undefined);
  assert.equal(sample.cpuPressurePercent, 0);
});

test("a macOS sample reads vm_stat and swap through the system tools", () => {
  const calls = [];
  const outputs = new Map([
    [
      "/usr/bin/vm_stat",
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 65536.\n",
    ],
    [
      "/usr/sbin/sysctl -n vm.swapusage",
      "total = 7168.00M  used = 5875.06M  free = 1292.94M  (encrypted)\n",
    ],
  ]);
  const sample = readResourceSignals({
    platform: "darwin",
    cpuCount: 4,
    totalMemoryBytes: 16 * 1024 ** 3,
    loadAverage: () => [1, 1, 1],
    now: () => 1,
    run: (command, args) => {
      const key = [command, ...args].join(" ");
      calls.push(key);
      return outputs.get(key);
    },
  });
  assert.deepEqual(calls, [
    "/usr/bin/vm_stat",
    "/usr/sbin/sysctl -n vm.swapusage",
  ]);
  assert.equal(sample.memoryAvailableBytes, 65536 * 16384);
  assert.equal(sample.swapFreeBytes, Math.round(1292.94 * 1024 ** 2));
});
