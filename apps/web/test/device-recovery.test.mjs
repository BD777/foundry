import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);

const { deviceReadiness, disconnectCause, offlineSince } =
  await import("../src/lib/device-readiness.ts");
const { recoveryPlan, lingerCommand } =
  await import("../src/lib/device-recovery.ts");

const linuxDevice = (service, overrides = {}) => ({
  id: "dev_small",
  label: "small-box",
  status: "disconnected",
  lastSeenLabel: "offline",
  owned: true,
  system: {
    hostname: "small-box",
    os: "Debian GNU/Linux",
    arch: "x64",
    memoryBytes: 2 * 1024 ** 3,
    swapBytes: 0,
    user: "admin",
    ...(service ? { service } : {}),
  },
  ...overrides,
});

test("a 1006 / unexpected EOF reads as the device closing the connection", () => {
  assert.equal(
    disconnectCause({
      lastDisconnect: {
        at: "2026-10-29T10:01:00Z",
        serverReason:
          "websocket: close 1006 (abnormal closure): unexpected EOF",
      },
    }),
    "device_closed",
  );
  assert.equal(
    disconnectCause({
      lastDisconnect: { at: "x", serverReason: "read deadline: i/o timeout" },
    }),
    "network",
  );
  assert.equal(
    disconnectCause({
      lastDisconnect: { at: "x", worker: { closedBy: "network" } },
    }),
    "network",
  );
  assert.equal(disconnectCause({}), undefined);
});

test("offline since prefers the recorded drop, then the row's last write", () => {
  assert.equal(
    offlineSince({
      status: "disconnected",
      lastSeenAt: "2026-10-29T10:01:05Z",
      lastDisconnect: { at: "2026-10-29T10:01:00Z" },
    }),
    "2026-10-29T10:01:00Z",
  );
  assert.equal(
    offlineSince({
      status: "disconnected",
      lastSeenAt: "2026-10-29T10:01:05Z",
    }),
    "2026-10-29T10:01:05Z",
  );
  assert.equal(
    offlineSince({ status: "connected", lastSeenAt: "x" }),
    undefined,
  );
});

test("linger off is a readiness problem with its one-line fix", () => {
  const readiness = deviceReadiness({
    device: linuxDevice(
      {
        manager: "systemd",
        unit: "foundry-worker.service",
        installed: true,
        linger: false,
        oomKills: { count: 2, lastAt: "2026-10-29T10:01:00Z" },
      },
      { status: "connected" },
    ),
    providerHealth: [
      {
        deviceId: "dev_small",
        provider: "claude",
        status: "healthy",
        authMode: "local_config",
        secretStored: "local",
        cli: {
          installed: true,
          version: "2.1.308",
          update: { state: "current", checkedAt: "x" },
        },
      },
      {
        deviceId: "dev_small",
        provider: "codex",
        status: "healthy",
        authMode: "local_config",
        secretStored: "local",
        cli: {
          installed: true,
          version: "0.165.0",
          update: { state: "current", checkedAt: "x" },
        },
      },
    ],
  });
  assert.equal(readiness.keepsRunning, "no");
  assert.equal(readiness.summary, "needs_setup");
  assert.equal(readiness.noSwap, true);
  assert.equal(readiness.oomKills.count, 2);
  assert.equal(lingerCommand("admin"), "sudo loginctl enable-linger admin");
});

test("Bring it back names the unit the worker installed, and the linger fix when it is off", () => {
  const plan = recoveryPlan(
    linuxDevice({
      manager: "systemd",
      unit: "foundry-worker.stage.service",
      installed: true,
      linger: false,
      logDir: "~/.foundry-stage/logs",
    }),
    { lowMemory: true },
  );
  assert.equal(plan.platform, "linux");
  assert.equal(plan.unitAssumed, false);
  assert.deepEqual(
    plan.steps.map((step) => step.key),
    ["status", "linger", "restart", "logs", "memory"],
  );
  assert.deepEqual(plan.steps[0].commands, [
    "systemctl --user status foundry-worker.stage.service",
  ]);
  assert.deepEqual(plan.steps[1].commands, [
    "sudo loginctl enable-linger admin",
  ]);
  assert.match(
    plan.steps[3].commands[1],
    /~\/\.foundry-stage\/logs\/daemon\.err\.log/,
  );
});

test("a worker too old to report its service gets the default names, marked as assumed", () => {
  const plan = recoveryPlan(linuxDevice(undefined));
  assert.equal(plan.unit, "foundry-worker.service");
  assert.equal(plan.unitAssumed, true);
  assert.ok(plan.steps.some((step) => step.key === "linger"));
  const mac = recoveryPlan({
    system: { hostname: "m", os: "macOS", arch: "arm64" },
  });
  assert.equal(mac.platform, "macos");
  assert.match(
    mac.steps[1].commands[0],
    /launchctl kickstart -k gui\/\$\(id -u\)\/dev\.foundry\.worker/,
  );
});
