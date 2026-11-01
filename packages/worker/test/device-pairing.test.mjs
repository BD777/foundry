import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

// Module-load-time state paths resolve from FOUNDRY_STATE_ROOT, so the
// isolated root must exist before the dist modules are imported.
const stateRoot = mkdtempSync(join(tmpdir(), "foundry-device-pairing-"));
process.env.FOUNDRY_STATE_ROOT = stateRoot;
delete process.env.FOUNDRY_STACK;

const {
  hostFingerprint,
  osAccountFingerprint,
  workerFingerprint,
  pairDevice,
  acquireDaemonLock,
  PairingError,
  SharedAccountError,
} = await import("../dist/device-pairing.js");
const { getDevice, devicePath } = await import("../dist/device.js");

test("fingerprints are stable hashes that never carry the raw machine id", () => {
  for (const value of [workerFingerprint(), hostFingerprint()]) {
    assert.equal(
      workerFingerprint() === value || hostFingerprint() === value,
      true,
    );
    for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const raw = readFileSync(path, "utf8").trim();
        if (raw)
          assert.ok(!value.includes(raw), "raw machine id must not leak");
      } catch {
        // Not present on this platform.
      }
    }
  }
});

test("the system account fingerprint follows the account, not the state root", () => {
  const account = osAccountFingerprint();
  const worker = workerFingerprint();
  const host = hostFingerprint();
  for (const value of [account, worker, host])
    assert.match(value, /^[0-9a-f]{64}$/);
  assert.equal(new Set([account, worker, host]).size, 3);
  // Another state root (a dev stack, FOUNDRY_STATE_ROOT) of the same
  // account is another device but the same system account.
  const otherRoot = mkdtempSync(join(tmpdir(), "foundry-device-pairing-b-"));
  process.env.FOUNDRY_STATE_ROOT = otherRoot;
  try {
    assert.notEqual(workerFingerprint(), worker);
    assert.equal(osAccountFingerprint(), account);
    assert.equal(hostFingerprint(), host);
  } finally {
    process.env.FOUNDRY_STATE_ROOT = stateRoot;
  }
  // Another account's home is another system account on the same machine.
  const home = process.env.HOME;
  process.env.HOME = otherRoot;
  try {
    assert.notEqual(osAccountFingerprint(), account);
    assert.equal(hostFingerprint(), host);
  } finally {
    process.env.HOME = home;
  }
  assert.ok(
    !account.includes(userInfo().username),
    "the user name never leaves the machine",
  );
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
      deviceId: local,
      workerFingerprint: workerFingerprint(),
      osAccountFingerprint: osAccountFingerprint(),
      hostFingerprint: hostFingerprint(),
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

test("a system account another person uses asks before pairing", async () => {
  const server = await fakeServer((request) =>
    request.body.acceptSharedAccount
      ? [201, { deviceId: "dev_assigned", credential: "shared" }]
      : [
          409,
          {
            error: "This computer account is already used by Alice in Foundry.",
            code: "system_account_shared",
            sharedWith: ["Alice"],
          },
        ],
  );
  try {
    await assert.rejects(
      pairDevice(server.url, "token-3"),
      (error) =>
        error instanceof SharedAccountError &&
        error.sharedWith.join() === "Alice" &&
        /already used by Alice/.test(error.message),
    );
    const accepted = await pairDevice(server.url, "token-3", {
      acceptSharedAccount: true,
    });
    assert.equal(accepted.credential, "shared");
    assert.equal(server.requests[1].body.acceptSharedAccount, true);
  } finally {
    server.close();
  }
});

test("only one daemon holds the state root; stale locks are reclaimed", async (t) => {
  const lock = join(stateRoot, "daemon.lock");
  // A live Foundry daemon blocks us.
  const daemon = spawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 60000)", "foundry-worker", "daemon"],
    { stdio: "ignore" },
  );
  t.after(() => daemon.kill("SIGKILL"));
  await new Promise((ready) => daemon.once("spawn", ready));
  writeFileSync(lock, String(daemon.pid));
  assert.throws(() => acquireDaemonLock(), /already running/);
  // After a crash or reboot the pid can belong to an unrelated process.
  writeFileSync(lock, String(process.ppid));
  acquireDaemonLock();
  assert.equal(readFileSync(lock, "utf8"), String(process.pid));
  // A dead holder's lock is stale.
  writeFileSync(lock, "999999999");
  acquireDaemonLock();
  assert.equal(readFileSync(lock, "utf8"), String(process.pid));
});
