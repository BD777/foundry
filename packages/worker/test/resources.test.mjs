import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  builtinDetectors,
  execBounded,
  ResourceScanner,
  runDetector,
  scannerVersion,
} from "../dist/resources/index.js";
import {
  awsProfiles,
  githubLogins,
} from "../dist/resources/detectors/account.js";
import { diskDetector } from "../dist/resources/detectors/disk.js";
import { toolchainDetector } from "../dist/resources/detectors/toolchain.js";

const ready = { ready: true, level: "installed" };

function fakeDetector(id, detect, extra = {}) {
  return {
    id,
    version: 1,
    type: "toolchain",
    platforms: [process.platform],
    intervalMs: 60_000,
    timeoutMs: 1000,
    detect,
    ...extra,
  };
}

test("a detector's instances carry its name; a failure or timeout is its own", async () => {
  const found = await runDetector(
    fakeDetector("ok", async () => [
      {
        key: "toolchain/x",
        type: "toolchain",
        platform: "linux",
        name: "x",
        readiness: ready,
      },
    ]),
  );
  assert.deepEqual(
    found.instances.map((i) => i.detector),
    ["ok@1"],
  );
  const thrown = await runDetector(
    fakeDetector("bad", async () => {
      throw new Error("broken config");
    }),
  );
  assert.deepEqual(thrown, { instances: [], error: "broken config" });
  let aborted = false;
  const slow = await runDetector(
    fakeDetector(
      "slow",
      (context) =>
        new Promise((resolveDetect) => {
          context.signal.addEventListener("abort", () => {
            aborted = true;
            resolveDetect([]);
          });
        }),
      { timeoutMs: 50 },
    ),
  );
  assert.equal(slow.error, "timed out after 50ms");
  assert.ok(aborted, "the detector's signal is aborted at its time limit");
  const elsewhere = await runDetector(
    fakeDetector("elsewhere", async () => assert.fail("ran"), {
      platforms: ["aix"],
    }),
  );
  assert.deepEqual(elsewhere, { instances: [] });
});

test(
  "bounded runs kill a program that outlives its limit",
  { skip: process.platform === "win32" },
  async () => {
    const started = Date.now();
    const run = await execBounded("/bin/sh", ["-c", "sleep 5"], {
      timeoutMs: 100,
    });
    assert.ok(run.timedOut);
    assert.ok(Date.now() - started < 3000);
    const missing = await execBounded("foundry-no-such-program", []);
    assert.ok(missing.missing);
  },
);

test("the scanner reports a whole snapshot on attach, then only changes", async () => {
  let version = "1.0";
  let failing = false;
  const scanner = new ResourceScanner({
    detectors: [
      fakeDetector("tool", async () => [
        {
          key: "toolchain/x",
          type: "toolchain",
          platform: "linux",
          name: `x ${version}`,
          readiness: ready,
        },
      ]),
      fakeDetector("flaky", async () => {
        if (failing) throw new Error("timeout");
        return [];
      }),
    ],
  });
  const sent = [];
  scanner.attach({ send: (report) => (sent.push(report), true) });
  await scanner.scanAll();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].scannerVersion, scannerVersion);
  assert.deepEqual(
    sent[0].instances.map((i) => i.name),
    ["x 1.0"],
  );
  await scanner.scanAll();
  assert.equal(sent.length, 1, "nothing changed, nothing sent");
  version = "2.0";
  failing = true;
  await scanner.scanAll();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].detectorErrors, [
    { detector: "flaky@1", type: "toolchain", error: "timeout" },
  ]);
  scanner.detach();
  scanner.attach({ send: (report) => (sent.push(report), true) });
  await scanner.scanAll();
  assert.equal(sent.length, 3, "a new connection hears the whole snapshot");
  scanner.detach();
});

test("detectors reporting one instance merge into one with both backends", async () => {
  const desktop = (backend, isReady) => ({
    key: "computer_use/macos/console:501",
    type: "computer_use",
    platform: "macos",
    name: "Desktop",
    readiness: isReady
      ? { ready: true, level: "permitted" }
      : { ready: false, level: "installed", reason: "not granted" },
    backends: [{ id: backend, mode: "listed", readiness: ready }],
  });
  const scanner = new ResourceScanner({
    detectors: [
      fakeDetector("a", async () => [desktop("a", false)]),
      fakeDetector("b", async () => [desktop("b", true)]),
    ],
  });
  const report = await scanner.scanAll();
  assert.equal(report.instances.length, 1);
  assert.deepEqual(report.instances[0].readiness, {
    ready: true,
    level: "permitted",
  });
  assert.deepEqual(
    report.instances[0].backends.map((b) => b.id),
    ["a", "b"],
  );
});

test("a remotely operated backend leads the merged instance", async () => {
  const desktop = (backend, mode, readiness, details) => ({
    key: "computer_use/macos/console:501",
    type: "computer_use",
    platform: "macos",
    name: "macOS screen control",
    readiness,
    backends: [{ id: backend, mode, readiness }],
    details,
  });
  const worker = { ready: true, level: "permitted" };
  const driver = {
    ready: false,
    level: "configured",
    reason: "Waiting for you on the Mac",
    missing: ["cua_driver_awaiting_approval"],
  };
  const scanner = new ResourceScanner({
    detectors: [
      fakeDetector("worker", async () => [
        desktop("foundry-worker", "native_session", worker, {
          grantTo: "/usr/bin/node",
        }),
      ]),
      fakeDetector("driver", async () => [
        desktop("cua-driver", "remote_ops", driver, {
          grantTo: "CuaDriver.app",
        }),
      ]),
    ],
  });
  const [instance] = (await scanner.scanAll()).instances;
  assert.deepEqual(instance.readiness, driver);
  assert.deepEqual(
    instance.backends.map((b) => b.id),
    ["cua-driver", "foundry-worker"],
  );
  assert.deepEqual(instance.details, { grantTo: "CuaDriver.app" });
});

test("account names are read without their secrets", () => {
  const hosts = [
    "github.com:",
    "    users:",
    "        octo:",
    "            oauth_token: gho_secret",
    "    git_protocol: https",
    "    oauth_token: gho_secret",
    "    user: octo",
    "ghe.example.com:",
    "    user: someone",
  ].join("\n");
  assert.deepEqual(githubLogins(hosts), [
    { host: "github.com", user: "octo" },
    { host: "ghe.example.com", user: "someone" },
  ]);
  assert.deepEqual(
    awsProfiles(
      "[default]\nregion = us-east-1\n[profile dev]\n[sso-session corp]\n",
    ),
    ["default", "dev"],
  );
});

test("toolchains on PATH are listed with their versions", async (t) => {
  const bin = mkdtempSync(join(tmpdir(), "foundry-toolchain-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(
    join(bin, "go"),
    "#!/bin/sh\necho go version go1.23.4 linux/amd64\n",
  );
  chmodSync(join(bin, "go"), 0o755);
  const { instances, error } = await runDetector(toolchainDetector, {
    platform: "linux",
    env: { PATH: bin },
  });
  assert.equal(error, undefined);
  assert.deepEqual(
    instances.map((i) => [i.key, i.name, i.details.version]),
    [["toolchain/go", "Go 1.23.4", "1.23.4"]],
  );
});

test("the workspace volume's free space is reported in whole GiB", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "foundry-disk-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const { instances, error } = await runDetector(diskDetector, {
    workspacePaths: () => [workspace],
  });
  assert.equal(error, undefined);
  assert.equal(instances.length, 1);
  assert.match(instances[0].key, /^disk\//);
  assert.match(instances[0].details.freeGiB, /^\d+$/);
  assert.equal(instances[0].details.workspaces, workspace);
});

test("every built-in detector is bounded and runs on every desktop platform it names", () => {
  const ids = new Set();
  for (const detector of builtinDetectors) {
    assert.ok(!ids.has(detector.id), `${detector.id} twice`);
    ids.add(detector.id);
    assert.ok(
      detector.timeoutMs > 0 && detector.timeoutMs <= 10_000,
      detector.id,
    );
    assert.ok(detector.intervalMs >= 60_000, detector.id);
    assert.ok(
      detector.platforms.every((p) => ["darwin", "linux", "win32"].includes(p)),
      detector.id,
    );
  }
});

test("the built-in detectors run on this device without failing", async () => {
  const scanner = new ResourceScanner();
  const report = await scanner.scanAll();
  assert.deepEqual(report.detectorErrors, []);
  for (const instance of report.instances) {
    assert.match(instance.detector, /^[\w.-]+@\d+$/);
    assert.notEqual(instance.readiness.level, "verified");
  }
});
