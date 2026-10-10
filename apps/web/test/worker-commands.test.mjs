import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);

const {
  loadWorkerRelease,
  npxUpdateCommand,
  npxWorkerCommand,
  workerReleaseReuseMs,
} = await import("../src/lib/worker-commands.ts");
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

test("components showing the worker release share one read", async (t) => {
  const reads = [];
  let fail = false;
  t.mock.method(globalThis, "fetch", async (url) => {
    reads.push(String(url));
    if (fail) return new Response("{}", { status: 503 });
    return new Response(JSON.stringify(served), {
      headers: { "Content-Type": "application/json" },
    });
  });
  const now = 5_000_000;
  const [a, b, c] = await Promise.all([
    loadWorkerRelease(now),
    loadWorkerRelease(now),
    loadWorkerRelease(now + 10),
  ]);
  assert.equal(reads.length, 1, "panels mounting together read once");
  assert.equal(reads[0], "http://127.0.0.1:31982/api/worker/release");
  assert.deepEqual(
    [a.version, b.version, c.version],
    Array(3).fill(served.version),
  );
  await loadWorkerRelease(now + workerReleaseReuseMs - 1);
  assert.equal(reads.length, 1);
  // Later mounts read again: the server may repack without a restart.
  fail = true;
  const later = now + workerReleaseReuseMs;
  await assert.rejects(loadWorkerRelease(later));
  assert.equal(reads.length, 2);
  fail = false;
  await loadWorkerRelease(later + 1);
  assert.equal(reads.length, 3, "a failed read is not kept");
});
