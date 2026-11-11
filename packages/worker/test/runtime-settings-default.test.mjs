import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "foundry-runtime-settings-"));
process.env.FOUNDRY_STATE_ROOT = root;
delete process.env.FOUNDRY_MAX_CONCURRENT_TASKS;
delete process.env.FOUNDRY_EXECUTOR_SETTINGS;
test.after(() => rmSync(root, { recursive: true, force: true }));

const {
  deviceHardware,
  normalizeAgentRuntimeSettings,
  readAgentRuntimeSettings,
  runtimeSettingsPath,
  writeAgentRuntimeSettings,
} = await import("../dist/device/device.js");
const { adaptiveConcurrencyFloor } =
  await import("../dist/concurrency/admission-policy.js");

const floor = () => adaptiveConcurrencyFloor(deviceHardware().cpus);

test("the adaptive floor is four through 16 turns by CPU count", () => {
  assert.equal(adaptiveConcurrencyFloor(64), 16);
  assert.equal(adaptiveConcurrencyFloor(10), 16);
  assert.equal(adaptiveConcurrencyFloor(8), 16);
  assert.equal(adaptiveConcurrencyFloor(3), 6);
  assert.equal(adaptiveConcurrencyFloor(2), 4);
  assert.equal(adaptiveConcurrencyFloor(1), 4);
  assert.equal(adaptiveConcurrencyFloor(undefined), 4);
});

test("adaptive is the default and its legacy field carries the floor", () => {
  const settings = readAgentRuntimeSettings();
  assert.equal(settings.mode, "adaptive");
  assert.equal(settings.maxConcurrentTasks, floor());
  assert.equal(settings.hardwareMaxConcurrentTasks, floor());
  assert.ok(settings.hardware.memoryGiB > 0 && settings.hardware.cpus > 0);
});

test("forced mode and adaptive mode both write the legacy field", () => {
  const owned = writeAgentRuntimeSettings({
    activeRuntimeTtlMs: 30 * 60_000,
    mode: "forced",
    forcedLimit: 10,
  });
  assert.equal(owned.mode, "forced");
  assert.equal(owned.forcedLimit, 10);
  assert.deepEqual(
    (({ maxConcurrentTasks, maxConcurrentTasksSource }) => ({
      maxConcurrentTasks,
      maxConcurrentTasksSource,
    }))(JSON.parse(readFileSync(runtimeSettingsPath, "utf8"))),
    { maxConcurrentTasks: 10, maxConcurrentTasksSource: "owner" },
  );

  const adaptive = writeAgentRuntimeSettings({
    activeRuntimeTtlMs: 30 * 60_000,
    mode: "adaptive",
  });
  assert.equal(adaptive.mode, "adaptive");
  assert.equal(adaptive.forcedLimit, undefined);
  assert.equal(adaptive.maxConcurrentTasks, floor());
  assert.equal(adaptive.activeRuntimeTtlMs, 30 * 60_000);
  const stored = JSON.parse(readFileSync(runtimeSettingsPath, "utf8"));
  assert.equal(stored.maxConcurrentTasks, floor());
  assert.equal(stored.maxConcurrentTasksSource, "hardware");
  assert.equal(stored.mode, "adaptive");
});

test("an explicit old fixed setting migrates to the same forced limit", () => {
  writeFileSync(
    runtimeSettingsPath,
    JSON.stringify({
      activeRuntimeTtlMs: 60_000,
      maxConcurrentTasks: 6,
    }),
  );
  const migrated = readAgentRuntimeSettings();
  assert.equal(migrated.mode, "forced");
  assert.equal(migrated.forcedLimit, 6);
  const stored = JSON.parse(readFileSync(runtimeSettingsPath, "utf8"));
  assert.equal(stored.mode, "forced");
  assert.equal(stored.forcedLimit, 6);
  assert.equal(stored.maxConcurrentTasks, 6);
});

test("an old hardware-derived value becomes adaptive", () => {
  writeFileSync(
    runtimeSettingsPath,
    JSON.stringify({
      activeRuntimeTtlMs: 60_000,
      maxConcurrentTasks: 7,
      maxConcurrentTasksSource: "hardware",
    }),
  );
  const migrated = readAgentRuntimeSettings();
  assert.equal(migrated.mode, "adaptive");
  assert.equal(migrated.maxConcurrentTasks, floor());
  const stored = JSON.parse(readFileSync(runtimeSettingsPath, "utf8"));
  assert.equal(stored.mode, "adaptive");
  assert.equal(stored.maxConcurrentTasks, floor());
});

test("the environment limit remains forced", () => {
  process.env.FOUNDRY_MAX_CONCURRENT_TASKS = "6";
  const forced = normalizeAgentRuntimeSettings({
    activeRuntimeTtlMs: 60_000,
    mode: "adaptive",
  });
  delete process.env.FOUNDRY_MAX_CONCURRENT_TASKS;
  assert.equal(forced.mode, "forced");
  assert.equal(forced.forcedLimit, 6);
});
