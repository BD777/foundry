import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);

const {
  assignmentNote,
  deviceReadiness,
  runtimeAction,
  runtimeInstallKey,
  runtimesToInstall,
  memoryLabel,
} = await import("../src/lib/device-readiness.ts");

const device = (overrides = {}) => ({
  id: "dev_new",
  label: "new-box",
  status: "connected",
  lastSeenLabel: "now",
  owned: true,
  system: { platform: "linux", arch: "x64", memoryBytes: 2 * 1024 ** 3 },
  ...overrides,
});
const health = (provider, cli, status = "unavailable") => ({
  deviceId: "dev_new",
  provider,
  status,
  authMode: "missing",
  secretStored: "local",
  cli,
});
const missingBoth = [
  health("claude", { installed: false }),
  health("codex", { installed: false }),
];
const provider = { id: "prof_gw", runtime: "claude", authMode: "custom" };
const assigned = [{ deviceId: "dev_new", profileId: "prof_gw", enabled: true }];

test("a device with neither runtime needs setup, and each runtime offers Install", () => {
  const readiness = deviceReadiness({
    device: device(),
    providerHealth: missingBoth,
  });
  assert.equal(readiness.summary, "needs_setup");
  assert.equal(readiness.runtimes.claude.state, "missing");
  assert.equal(runtimeAction(readiness.runtimes.codex), "install");
  // 2 GiB: Claude Code would be tight; said, not blocked.
  assert.equal(readiness.lowMemory, true);
  assert.equal(memoryLabel(2 * 1024 ** 3), "2 GiB");
});

test("a provider assigned to a device whose runtime is missing installs it on assignment", () => {
  const readiness = deviceReadiness({
    device: device({ system: undefined }),
    providerHealth: [
      health("claude", { installed: false }),
      health("codex", { installed: true, version: "0.160.0" }, "missing_auth"),
    ],
    bindings: assigned,
    profiles: [provider],
  });
  assert.equal(readiness.runtimes.claude.assigned, 1);
  // Codex is there, but the assigned provider needs Claude Code.
  assert.equal(readiness.summary, "needs_setup");
  assert.deepEqual(runtimesToInstall(readiness, ["claude", "codex"]), [
    "claude",
  ]);
  assert.equal(assignmentNote(readiness, "claude"), "willInstall");
  assert.equal(assignmentNote(readiness, "codex"), undefined);
  assert.equal(readiness.lowMemory, false);
});

test("offline or someone else's device: nothing installs, and the note says why", () => {
  const offline = deviceReadiness({
    device: device({ status: "disconnected" }),
    providerHealth: missingBoth,
  });
  assert.deepEqual(runtimesToInstall(offline, ["claude"]), []);
  assert.equal(assignmentNote(offline, "claude"), "offline");
  const shared = deviceReadiness({
    device: device({ owned: false }),
    providerHealth: missingBoth,
  });
  assert.deepEqual(runtimesToInstall(shared, ["claude"]), []);
  assert.equal(assignmentNote(shared, "claude"), "notOwner");
});

test("an install shows as installing from the page's request, then from the worker's report", () => {
  const key = runtimeInstallKey("dev_new", "claude");
  const started = deviceReadiness({
    device: device(),
    providerHealth: missingBoth,
    installs: new Map([[key, { state: "running", startedAt: 1000 }]]),
  });
  assert.equal(started.runtimes.claude.state, "installing");
  assert.equal(started.runtimes.claude.startedAt, 1000);
  assert.equal(started.summary, "installing");
  // Another tab: no request of its own, only the worker's report.
  const reported = deviceReadiness({
    device: device(),
    providerHealth: [
      health("claude", {
        installed: false,
        update: { state: "updating", checkedAt: "2026-10-29T10:00:00Z" },
      }),
      missingBoth[1],
    ],
  });
  assert.equal(reported.runtimes.claude.state, "installing");
  assert.equal(
    reported.runtimes.claude.startedAt,
    Date.parse("2026-10-29T10:00:00Z"),
  );
});

test("a failed install offers Retry with the worker's reason", () => {
  const readiness = deviceReadiness({
    device: device(),
    providerHealth: [
      health("claude", {
        installed: false,
        update: {
          state: "failed",
          checkedAt: "2026-10-29T10:00:00Z",
          detail: "npm error network",
        },
      }),
      missingBoth[1],
    ],
  });
  assert.equal(readiness.runtimes.claude.state, "install_failed");
  assert.equal(readiness.runtimes.claude.detail, "npm error network");
  assert.equal(runtimeAction(readiness.runtimes.claude), "retry");
  assert.equal(assignmentNote(readiness, "claude"), "willInstall");
});

test("a finished install counts before the device's report arrives", () => {
  const key = runtimeInstallKey("dev_new", "codex");
  const readiness = deviceReadiness({
    device: device(),
    providerHealth: missingBoth,
    installs: new Map([
      [
        key,
        {
          state: "succeeded",
          startedAt: 1,
          cli: { installed: true, version: "0.161.0" },
        },
      ],
    ]),
  });
  assert.equal(readiness.runtimes.codex.state, "ready");
  assert.equal(readiness.runtimes.codex.version, "0.161.0");
});

test("a user-installed copy behind the release offers the Foundry-managed copy; a managed one is ready", () => {
  const readiness = deviceReadiness({
    device: device(),
    providerHealth: [
      health(
        "claude",
        {
          installed: true,
          version: "2.1.290",
          update: {
            state: "external",
            checkedAt: "2026-10-29T10:00:00Z",
            current: "2.1.290",
            target: "2.1.300",
          },
        },
        "healthy",
      ),
      health(
        "codex",
        {
          installed: true,
          version: "0.161.0",
          update: { state: "current", checkedAt: "2026-10-29T10:00:00Z" },
        },
        "healthy",
      ),
    ],
  });
  assert.equal(readiness.runtimes.claude.state, "external_update");
  assert.equal(readiness.runtimes.claude.managed, false);
  assert.equal(runtimeAction(readiness.runtimes.claude), "switch");
  assert.equal(readiness.runtimes.codex.state, "ready");
  assert.equal(readiness.runtimes.codex.managed, true);
  assert.equal(readiness.summary, "ready");
});

test("an old worker that reports no program is unknown, not missing", () => {
  const readiness = deviceReadiness({
    device: device(),
    providerHealth: [],
  });
  assert.equal(readiness.runtimes.claude.state, "unknown");
  assert.equal(readiness.summary, "unknown");
});
