import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Module-load-time state paths resolve from FOUNDRY_STATE_ROOT, so the
// isolated root must exist before the dist modules are imported.
const stateRoot = mkdtempSync(join(tmpdir(), "foundry-device-pairing-"));
process.env.FOUNDRY_STATE_ROOT = stateRoot;
delete process.env.FOUNDRY_STACK;

const { machineFingerprint, pairDevice, acquireDaemonLock, PairingError } =
  await import("../dist/device-pairing.js");
const { getDevice, devicePath } = await import("../dist/device.js");

test("the machine fingerprint is a stable hash, distinct per dev stack", () => {
  const first = machineFingerprint();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(machineFingerprint(), first);
  process.env.FOUNDRY_STACK = "lab";
  try {
    assert.notEqual(machineFingerprint(), first);
  } finally {
    delete process.env.FOUNDRY_STACK;
  }
  for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const raw = readFileSync(path, "utf8").trim();
      if (raw) assert.ok(!first.includes(raw), "raw machine id must not leak");
    } catch {
      // Not present on this platform.
    }
  }
});

async function fakeServer(handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, body: JSON.parse(body || "{}") });
    const [status, payload] = handler(requests.at(-1));
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => server.close(),
  };
}

test("pairing sends the fingerprint and local id and adopts the server's device id", async () => {
  const local = getDevice().id;
  const server = await fakeServer(() => [
    201,
    { deviceId: "dev_assigned", credential: "secret-credential" },
  ]);
  try {
    const result = await pairDevice(server.url, " token-1 ");
    assert.deepEqual(result, {
      deviceId: "dev_assigned",
      credential: "secret-credential",
    });
    assert.equal(server.requests[0].url, "/api/daemon/pair");
    assert.deepEqual(server.requests[0].body, {
      token: "token-1",
      machineFingerprint: machineFingerprint(),
      deviceId: local,
    });
    const stored = JSON.parse(readFileSync(devicePath, "utf8"));
    assert.equal(stored.id, "dev_assigned");
    assert.equal(stored.runtimeSettings, undefined);
  } finally {
    server.close();
  }
});

test("a rejected pairing token surfaces the server's reason", async () => {
  const server = await fakeServer(() => [
    401,
    { error: "device pairing token is invalid, expired or already used" },
  ]);
  try {
    await assert.rejects(
      pairDevice(server.url, "used"),
      (error) =>
        error instanceof PairingError &&
        error.status === 401 &&
        /already used/.test(error.message),
    );
  } finally {
    server.close();
  }
});

test("only one daemon holds the state root; stale locks are reclaimed", () => {
  const lock = join(stateRoot, "daemon.lock");
  // A live foreign holder (the test runner's parent process) blocks us.
  writeFileSync(lock, String(process.ppid));
  assert.throws(() => acquireDaemonLock(), /already running/);
  // A dead holder's lock is stale.
  writeFileSync(lock, "999999999");
  acquireDaemonLock();
  assert.equal(readFileSync(lock, "utf8"), String(process.pid));
});
