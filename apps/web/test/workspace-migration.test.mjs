import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);
const {
  migrationActive,
  migrationCancelable,
  migrationFrozen,
  migrationProgress,
  migrationReasonKey,
  migrationStepKey,
  moveTargetDenial,
  newerMigration,
  oldCopiesOn,
  suggestMigrationTargetPath,
  folderName,
} = await import("../src/components/workspace/workspace-migration.ts");
const { i18n } = await import("../src/i18n/index.ts");

test("a move pauses the workspace only while copying, verifying and switching", () => {
  const states = [
    "preflight",
    "copying",
    "verifying",
    "activating",
    "retiring",
    "complete",
    "canceled",
    "failed",
  ];
  assert.deepEqual(
    states.filter((state) => migrationFrozen({ state })),
    ["copying", "verifying", "activating"],
  );
  assert.deepEqual(
    states.filter((state) => migrationActive({ state })),
    ["preflight", "copying", "verifying", "activating", "retiring"],
  );
  assert.deepEqual(
    states.filter((state) => migrationCancelable({ state })),
    ["preflight", "copying", "verifying"],
  );
  assert.equal(migrationActive(undefined), false);
  assert.equal(migrationFrozen(undefined), false);
});

test("every known step and reason has a label in both locales", async () => {
  const steps = [
    "queued",
    "checking",
    "scanning",
    "checking_target",
    "streaming",
    "retrying",
    "copying_changes",
    "verifying_target",
    "rescanning",
    "activating_target",
    "retiring_source",
    "aborting",
  ];
  const reasons = [
    "device_offline",
    "worker_outdated",
    "target_path_taken",
    "target_path_unavailable",
    "not_enough_space",
    "workspace_busy",
    "device_refused",
    "transfer_retrying",
    "transfer_failed",
    "verify_mismatch",
    "canceled_by_person",
  ];
  assert.equal(migrationStepKey("done"), undefined);
  assert.equal(migrationStepKey(""), undefined);
  assert.equal(migrationReasonKey("something_new"), undefined);
  for (const language of ["en", "zh-CN"]) {
    const t = i18n.getFixedT(language, "workspaces");
    for (const step of steps) {
      const key = migrationStepKey(step);
      assert.equal(key, `move.steps.${step}`);
      assert.ok(i18n.exists(`workspaces:${key}`, { lng: language }), key);
      assert.doesNotMatch(t(key, { source: "Mac", target: "Linux" }), /{{/);
    }
    for (const reason of reasons) {
      const key = migrationReasonKey(reason);
      assert.ok(i18n.exists(`workspaces:${key}`, { lng: language }), key);
    }
  }
});

test("progress is bytes of the total once known, files before, else indeterminate", () => {
  assert.deepEqual(
    migrationProgress({
      bytes: 50,
      totalBytes: 200,
      files: 1,
      totalFiles: 4,
    }),
    { value: 50, max: 200 },
  );
  assert.deepEqual(
    migrationProgress({ bytes: 900, totalBytes: 200 }),
    { value: 200, max: 200 },
    "never past the total",
  );
  assert.deepEqual(
    migrationProgress({ bytes: 0, totalBytes: 0, files: 3, totalFiles: 6 }),
    { value: 3, max: 6 },
  );
  assert.equal(migrationProgress({}), undefined);
});

test("the default folder sits beside the target's workspaces, else in its home", () => {
  assert.equal(
    suggestMigrationTargetPath("/Users/dev/code/foundry/", [
      "/home/me/src/a",
      "/home/me/src/b",
      "/opt/c",
    ]),
    "/home/me/src/foundry",
  );
  assert.equal(
    suggestMigrationTargetPath("/Users/dev/foundry", []),
    "~/foundry",
  );
  assert.equal(
    suggestMigrationTargetPath("C:\\work\\site", ["D:\\projects\\one"]),
    "D:\\projects\\site",
  );
  assert.equal(suggestMigrationTargetPath("/srv/app", ["/top"]), "/app");
  assert.equal(folderName("C:\\work\\site\\"), "site");
});

test("targets: other owned devices; offline ones say so", () => {
  assert.equal(
    moveTargetDenial({ id: "a", status: "connected", owned: true }, "a"),
    "current",
  );
  assert.equal(
    moveTargetDenial({ id: "b", status: "connected", owned: false }, "a"),
    "notOwned",
  );
  assert.equal(
    moveTargetDenial({ id: "b", status: "disconnected", owned: true }, "a"),
    "offline",
  );
  assert.equal(
    moveTargetDenial({ id: "b", status: "connected", owned: true }, "a"),
    undefined,
  );
});

test("old copies are listed on the source device of complete moves only", () => {
  const moved = {
    id: "ws1",
    deviceId: "linux",
    migration: { id: "m1", state: "complete", sourceDeviceId: "mac" },
  };
  const moving = {
    id: "ws2",
    deviceId: "mac",
    migration: { id: "m2", state: "copying", sourceDeviceId: "mac" },
  };
  assert.deepEqual(
    oldCopiesOn([moved, moving, { id: "ws3" }], "mac").map((row) => row.id),
    ["ws1"],
  );
  assert.deepEqual(oldCopiesOn([moved], "linux"), []);
});

test("an older reading of the same move does not replace a newer one", () => {
  const held = { id: "m", updatedAt: "2026-11-06T10:00:02Z" };
  assert.equal(
    newerMigration(held, { id: "m", updatedAt: "2026-11-06T10:00:01Z" }),
    false,
  );
  assert.equal(
    newerMigration(held, { id: "m", updatedAt: "2026-11-06T10:00:03Z" }),
    true,
  );
  assert.equal(newerMigration(held, { id: "other", updatedAt: "" }), true);
});

test("move sizes switch to GB from 1 GB", async () => {
  const { migrationSize } =
    await import("../src/components/workspace/workspace-migration.ts");
  const { formatBytes } = await import("../src/lib/format.ts");
  assert.equal(migrationSize(512), "512 B");
  assert.equal(migrationSize(8.4 * 1024 ** 2), "8.4 MB");
  assert.equal(migrationSize(734_003_200), "700 MB");
  assert.equal(migrationSize(3_865_470_566), "3.6 GB");
  assert.equal(formatBytes(3_865_470_566), "3686.4 MB", "GB is opt-in");
});
