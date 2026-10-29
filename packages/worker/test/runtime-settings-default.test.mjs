// DEV-084: without the owner's choice a device runs as many turns at once
// as its hardware allows; the owner's choice wins and can be withdrawn.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "foundry-runtime-settings-"));
process.env.FOUNDRY_STATE_ROOT = root;
delete process.env.FOUNDRY_MAX_CONCURRENT_TASKS;
delete process.env.FOUNDRY_EXECUTOR_SETTINGS;
test.after(() => rmSync(root, { recursive: true, force: true }));

const {
  hardwareMaxConcurrentTasks,
  normalizeAgentRuntimeSettings,
  readAgentRuntimeSettings,
  runtimeSettingsPath,
  writeAgentRuntimeSettings,
} = await import("../dist/device.js");

const GiB = 1024 ** 3;

test("one turn per 4 GiB and per 2 CPUs, the smaller, from 1 to 16", () => {
  assert.equal(hardwareMaxConcurrentTasks(252 * GiB, 64), 16);
  assert.equal(hardwareMaxConcurrentTasks(32 * GiB, 16), 8);
  assert.equal(hardwareMaxConcurrentTasks(64 * GiB, 10), 5);
  assert.equal(hardwareMaxConcurrentTasks(16 * GiB, 8), 4);
  assert.equal(hardwareMaxConcurrentTasks(7.5 * GiB, 2), 1);
  assert.equal(hardwareMaxConcurrentTasks(2 * GiB, 2), 1);
});

test("no owner choice: the hardware default, and its source", () => {
  const settings = readAgentRuntimeSettings();
  assert.equal(settings.maxConcurrentTasksSource, "hardware");
  assert.equal(settings.maxConcurrentTasks, hardwareMaxConcurrentTasks());
  assert.equal(
    settings.hardwareMaxConcurrentTasks,
    hardwareMaxConcurrentTasks(),
  );
  assert.ok(settings.hardware.memoryGiB > 0 && settings.hardware.cpus > 0);
});

test("the owner's choice wins; saving 0 returns to the hardware default", () => {
  const owned = writeAgentRuntimeSettings({
    activeRuntimeTtlMs: 30 * 60_000,
    maxConcurrentTasks: 10,
  });
  assert.equal(owned.maxConcurrentTasks, 10);
  assert.equal(owned.maxConcurrentTasksSource, "owner");
  assert.equal(readAgentRuntimeSettings().maxConcurrentTasks, 10);
  const back = writeAgentRuntimeSettings({
    activeRuntimeTtlMs: 30 * 60_000,
    maxConcurrentTasks: 0,
  });
  assert.equal(back.maxConcurrentTasksSource, "hardware");
  assert.equal(back.maxConcurrentTasks, hardwareMaxConcurrentTasks());
  assert.equal(back.activeRuntimeTtlMs, 30 * 60_000);
  const stored = JSON.parse(readFileSync(runtimeSettingsPath, "utf8"));
  assert.equal("maxConcurrentTasks" in stored, false, "no owner value kept");
});

test("settings handed to a sandboxed child keep their source", () => {
  const hardware = normalizeAgentRuntimeSettings({
    activeRuntimeTtlMs: 60_000,
    maxConcurrentTasks: 99,
    maxConcurrentTasksSource: "hardware",
  });
  assert.equal(hardware.maxConcurrentTasks, hardwareMaxConcurrentTasks());
  const owner = normalizeAgentRuntimeSettings({
    activeRuntimeTtlMs: 60_000,
    maxConcurrentTasks: 99,
  });
  assert.equal(owner.maxConcurrentTasks, 16);
  assert.equal(owner.maxConcurrentTasksSource, "owner");
});
