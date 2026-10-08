import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);

const { npxUpdateCommand, npxWorkerCommand } =
  await import("../src/lib/worker-commands.ts");
const { workerBehind } =
  await import("../src/features/devices/device-worker.tsx");

const served = {
  source: "server",
  version: "0.5.7-dev.2.gabc1234",
  packages: [
    {
      name: "@bd777/foundry-worker",
      url: "/api/worker/packages/w.tgz",
      latestUrl: "/api/worker/packages/latest/foundry-worker.tgz",
    },
  ],
};

test("a server build gets the one install-or-update command", () => {
  assert.equal(
    npxUpdateCommand(served, "https://dev.example.com"),
    "npx -y --prefer-offline --package=https://dev.example.com/api/worker/packages/latest/foundry-worker.tgz foundry-worker install --server https://dev.example.com",
  );
  assert.equal(
    npxUpdateCommand({ source: "npm" }, "https://foundry.example.com"),
    "npx -y @bd777/foundry-worker@latest update",
  );
});

test("a device is behind only when this server serves another version", () => {
  const device = {
    id: "d",
    label: "Mac",
    status: "connected",
    lastSeenLabel: "",
  };
  assert.equal(
    workerBehind({ ...device, worker: { version: served.version } }, served),
    false,
  );
  assert.equal(
    workerBehind({ ...device, worker: { version: "0.5.6" } }, served),
    true,
  );
  assert.equal(
    workerBehind(device, served),
    true,
    "an older worker reports no version",
  );
  assert.equal(workerBehind(device, { source: "npm" }), false);
});

test("the bootstrap runs the worker the server names", () => {
  assert.equal(
    npxWorkerCommand({ source: "npm" }, "https://foundry.example.com"),
    "npx -y @bd777/foundry-worker@latest",
  );
  assert.equal(
    npxWorkerCommand(
      {
        source: "server",
        version: "0.5.7-dev.2.gabc1234",
        packages: [
          {
            name: "@bd777/foundry-protocol",
            url: "/api/worker/packages/p.tgz",
            latestUrl: "/api/worker/packages/latest/foundry-protocol.tgz",
          },
          {
            name: "@bd777/foundry-worker",
            url: "/api/worker/packages/w.tgz",
            latestUrl: "/api/worker/packages/latest/foundry-worker.tgz",
            latestUrl: "/api/worker/packages/latest/foundry-worker.tgz",
          },
        ],
      },
      "https://dev.example.com",
    ),
    "npx -y --prefer-offline --package=https://dev.example.com/api/worker/packages/latest/foundry-protocol.tgz --package=https://dev.example.com/api/worker/packages/latest/foundry-worker.tgz foundry-worker",
  );
});
