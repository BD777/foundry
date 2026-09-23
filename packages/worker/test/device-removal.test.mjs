import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";

// Worker state paths are module-level constants (see device.ts/config.ts), so
// the isolated state root must exist before the dist modules are imported.
// `node --test <files>` runs each test file in its own child process, so this
// top-level assignment isolates module loading completely.
const stateRoot = mkdtempSync(join(tmpdir(), "foundry-device-removal-"));
process.env.FOUNDRY_STATE_ROOT = stateRoot;

// Safety guard: snapshot the real default state root's sensitive files and
// fail loudly (instead of silently mutating) if this test ever writes there.
const realRoot = join(homedir(), ".foundry");
const guardedRealFiles = [
  "device.json",
  "daemon-config.json",
  "device-removed.json",
  "workspaces.json",
  "runtime-settings.local.json",
];
const snapshotReal = () =>
  guardedRealFiles.map((name) => {
    const path = join(realRoot, name);
    try {
      const stat = statSync(path);
      return `${name}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `${name}:missing`;
    }
  });
const realBefore = snapshotReal();
process.on("exit", () => {
  const realAfter = snapshotReal();
  assert.deepEqual(
    realAfter,
    realBefore,
    "device removal tests must never modify the real ~/.foundry state root",
  );
});

const {
  clearDeviceRemovedMarker,
  deviceRemovedCloseCode,
  deviceRemovedReason,
  isDeviceRemovedSignal,
  parkAfterDeviceRemoval,
  prepareExplicitRepair,
  readDeviceRemovedMarker,
  writeDeviceRemovedMarker,
} = await import("../dist/device-removal.js");
const { devicePath, getDevice } = await import("../dist/device.js");
const { writeDaemonConfig } = await import("../dist/config.js");

test("device removal marker round-trips and clears", () => {
  assert.equal(readDeviceRemovedMarker(), undefined);

  const marker = {
    serverUrl: "http://127.0.0.1:9",
    deviceId: "dev_test",
    deviceLabel: "test",
    removedAt: new Date().toISOString(),
  };
  writeDeviceRemovedMarker(marker);
  assert.deepEqual(readDeviceRemovedMarker(), marker);

  clearDeviceRemovedMarker();
  assert.equal(readDeviceRemovedMarker(), undefined);
  // Clearing again is safe.
  clearDeviceRemovedMarker();
});

test("device removal never deletes local configuration files", () => {
  writeDaemonConfig({
    pairedAt: new Date().toISOString(),
    serverURL: "http://127.0.0.1:9",
    workspacePath: stateRoot,
    deviceCredential: "credential",
  });
  const device = getDevice();
  writeFileSync(join(stateRoot, "workspaces.json"), "[]");
  writeFileSync(join(stateRoot, "runtime-settings.local.json"), "{}");

  writeDeviceRemovedMarker({
    serverUrl: "http://127.0.0.1:9",
    deviceId: device.id,
    removedAt: new Date().toISOString(),
  });

  assert.ok(existsSync(devicePath));
  assert.ok(existsSync(join(stateRoot, "daemon-config.json")));
  assert.ok(existsSync(join(stateRoot, "workspaces.json")));
  assert.ok(existsSync(join(stateRoot, "runtime-settings.local.json")));
  assert.deepEqual(JSON.parse(readFileSync(devicePath, "utf8")), device);
});

test("device removal signal recognition across transports", () => {
  assert.equal(isDeviceRemovedSignal(null), false);
  assert.equal(isDeviceRemovedSignal(undefined), false);
  assert.equal(isDeviceRemovedSignal("a network error"), false);
  assert.equal(
    isDeviceRemovedSignal("/api/daemon/register returned 401: unauthorized"),
    false,
  );
  assert.equal(
    isDeviceRemovedSignal("/api/daemon/register returned 410: device_removed"),
    true,
  );
  assert.equal(isDeviceRemovedSignal("device_removed"), true);
  // The exact shape delivered by the ws "close" listener after toString().
  assert.equal(
    isDeviceRemovedSignal({
      code: deviceRemovedCloseCode,
      reason: Buffer.from(deviceRemovedReason).toString(),
    }),
    true,
  );
  assert.equal(
    isDeviceRemovedSignal({ code: 1006, reason: "abnormal closure" }),
    false,
  );
  assert.equal(
    isDeviceRemovedSignal({ code: 1000, reason: "device_removed" }),
    true,
  );
  assert.equal(isDeviceRemovedSignal({ message: "410 device_removed" }), true);
});

test("park keeps the daemon alive, quiet and heartbeat-fresh", async () => {
  const marker = {
    serverUrl: "http://127.0.0.1:9",
    deviceId: "dev_park",
    removedAt: new Date().toISOString(),
  };
  const abort = new AbortController();
  const parked = parkAfterDeviceRemoval(marker, {
    signal: abort.signal,
    heartbeatMs: 50,
  });
  let settled = false;
  parked.then(() => {
    settled = true;
  });
  // Park must not resolve on its own and must immediately write a heartbeat so
  // the watchdog never kills and the service never restart-loops.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(settled, false);
  const heartbeat = join(stateRoot, "daemon-heartbeat");
  assert.ok(existsSync(heartbeat));
  const age = Date.now() - new Date(readFileSync(heartbeat, "utf8")).getTime();
  assert.ok(age < 5_000, `heartbeat should be fresh, age=${age}ms`);
  // The abort (production equivalent: SIGTERM/SIGINT) settles park cleanly.
  abort.abort();
  await parked;
});

test("explicit repair clears the marker and rotates device identity", () => {
  const before = getDevice();
  writeDeviceRemovedMarker({
    serverUrl: "http://127.0.0.1:9",
    deviceId: before.id,
    removedAt: new Date().toISOString(),
  });

  assert.equal(prepareExplicitRepair(), true);
  assert.equal(readDeviceRemovedMarker(), undefined);
  // A second repair without a marker is a no-op: automatic paths must never
  // rotate identity.
  assert.equal(prepareExplicitRepair(), false);

  // pair/setup delete device.json after repair; getDevice() then mints a new
  // identity instead of colliding with the tombstoned one.
  rmSync(devicePath, { force: true });
  const after = getDevice();
  assert.notEqual(after.id, before.id);
  assert.match(after.id, /^dev_/);
});
