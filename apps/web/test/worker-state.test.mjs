import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);

const { workerState } =
  await import("../src/features/devices/device-worker.tsx");

const release = { source: "server", version: "0.5.7-dev.3", packages: [] };
const device = (overrides = {}) => ({
  id: "dev_1",
  label: "byte-dev",
  status: "connected",
  owned: true,
  capabilities: ["worker_update"],
  worker: { version: "0.5.7-dev.2", command: "~/.foundry/bin/foundry-worker" },
  ...overrides,
});

test("Update all acts only on owned, connected, self-updating devices behind the server", () => {
  assert.equal(workerState(device(), release), "updatable");
  assert.equal(
    workerState(
      device({ worker: { version: "0.5.7-dev.3", command: "x" } }),
      release,
    ),
    "current",
  );
  assert.equal(
    workerState(device({ status: "disconnected" }), release),
    "manual",
  );
  assert.equal(workerState(device({ capabilities: [] }), release), "manual");
  assert.equal(workerState(device({ owned: false }), release), "manual");
  assert.equal(
    workerState(
      device({ workerUpdate: { startedAt: "t", version: "0.5.7-dev.3" } }),
      release,
    ),
    "updating",
  );
  // An update that did not finish is shown, and can be started again.
  assert.equal(
    workerState(
      device({
        workerUpdate: { startedAt: "t", version: "0.5.7-dev.3", stalled: true },
      }),
      release,
    ),
    "stalled",
  );
  // A server on the npm release names no build to compare against.
  assert.equal(workerState(device(), { source: "npm" }), "current");
});
