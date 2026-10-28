import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processIdentity } from "../dist/agent-processes.js";
import { ExecutionHostClient } from "../dist/execution-host/client.js";
import { executionHostPaths } from "../dist/execution-host/paths.js";
import { reclaimExecutionService } from "../dist/execution-host/service.js";
import { daemonCameOnline } from "../dist/daemon-health.js";

const serverURL = "http://127.0.0.1:1";
process.env.FOUNDRY_EXECUTION_HANDSHAKE_TIMEOUT_MS = "300";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** A runner wedged as on 2026-10-28: takes connections, never answers, ignores SIGTERM. */
async function wedgedRunner(socketPath) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `process.on("SIGTERM", () => {});
       require("node:net").createServer(() => {}).listen(process.argv[1], () => console.log("ready"));`,
      socketPath,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise((done) => child.stdout.once("data", done));
  return child;
}

/** A healthy runner answering the handshake and snapshots. */
function healthyRunner(socketPath) {
  const identity = processIdentity(process.pid);
  try {
    unlinkSync(socketPath);
  } catch {}
  const server = createServer((socket) => {
    socket.on("error", () => {});
    createInterface({ input: socket }).on("line", (line) => {
      const request = JSON.parse(line);
      socket.write(
        `${JSON.stringify({
          id: request.id,
          result: {
            protocol: 1,
            capabilities: ["idle_upgrade", "drain_switch_v1"],
            entry: "/runtime/new/main.js",
            runtimeStamp: "new",
            serverURL,
            pid: process.pid,
            startTime: identity.startTime,
            claims: [],
            background: [],
          },
        })}\n`,
      );
    });
  });
  return new Promise((done) => server.listen(socketPath, () => done(server)));
}

async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "runner-reclaim-"));
  const socketPath = join(root, "control.sock");
  const identityPath = join(root, "identity.json");
  const wedged = await wedgedRunner(socketPath);
  writeFileSync(
    identityPath,
    JSON.stringify({
      pid: wedged.pid,
      startTime: processIdentity(wedged.pid).startTime,
    }),
  );
  const started = [];
  let healthy;
  const health = [];
  const client = new ExecutionHostClient(socketPath, "token", serverURL, {
    entry: "/runtime/new/main.js",
    stamp: "new",
    start: async () => {
      // A registered job proves nothing: start succeeds while it is wedged.
      started.push(Date.now());
      if (!processIdentity(wedged.pid) && !healthy)
        healthy = await healthyRunner(socketPath);
    },
    stop: async () => {},
    // The job manager's stop leaves the SIGTERM-proof owner alive here.
    reclaim: () => reclaimExecutionService(async () => {}, identityPath, 300),
    legacyAlone: () => false,
  });
  client.setHealthSink((value) => health.push(value));
  t.after(() => {
    client.close();
    healthy?.close();
    if (processIdentity(wedged.pid)) wedged.kill("SIGKILL");
    rmSync(executionHostPaths().root + "/heartbeat.json", { force: true });
    rmSync(root, { recursive: true, force: true });
  });
  return { client, wedged, health, started };
}

test("a runner that takes connections and never answers is reclaimed", async (t) => {
  const { client, wedged, health } = await setup(t);
  // The connection service's 5 s refresh retries; each try is bounded.
  for (let i = 0; i < 3; i++) await client.open().catch(() => undefined);
  assert.equal(
    processIdentity(wedged.pid),
    undefined,
    "the SIGTERM-proof owner was killed by identity",
  );
  assert.equal(client.hostHealth(), "ready");
  assert.ok(health.includes("reclaiming"));
  assert.ok(health.includes("unavailable"));
  assert.equal(client.runner().state, "current");
});

test("a runner whose heartbeat goes on is slow, not wedged", async (t) => {
  const { client, wedged } = await setup(t);
  const beat = (at) => {
    mkdirSync(executionHostPaths().root, { recursive: true });
    writeFileSync(
      join(executionHostPaths().root, "heartbeat.json"),
      JSON.stringify({
        pid: wedged.pid,
        startTime: processIdentity(wedged.pid).startTime,
        at,
      }),
    );
  };
  beat(new Date().toISOString());
  for (let i = 0; i < 4; i++) await client.open().catch(() => undefined);
  assert.ok(processIdentity(wedged.pid), "an answering heartbeat keeps it");
  assert.equal(client.runner().state, "unavailable");
  beat(new Date(Date.now() - 120_000).toISOString());
  await client.open().catch(() => undefined);
  await pause(50);
  assert.equal(processIdentity(wedged.pid), undefined);
  assert.equal(client.hostHealth(), "ready");
});

test("an update succeeds only once the restarted worker is online", () => {
  const since = Date.now() - 1000;
  const self = processIdentity(process.pid);
  const health = {
    pid: process.pid,
    startTime: self.startTime,
    version: "0.5.8",
    startedAt: new Date().toISOString(),
    at: new Date().toISOString(),
  };
  assert.match(
    daemonCameOnline("0.5.8", since, health).reason,
    /not connected/,
  );
  const connected = { ...health, connectedAt: health.at };
  assert.match(
    daemonCameOnline("0.5.8", since, {
      ...connected,
      runner: "unavailable",
      runnerDetail: "timed out",
    }).reason,
    /runner is unavailable \(timed out\)/,
  );
  assert.equal(
    daemonCameOnline("0.5.8", since, { ...connected, runner: "reclaiming" }).ok,
    true,
  );
  assert.equal(
    daemonCameOnline("0.5.8", since, { ...connected, runner: "ready" }).ok,
    true,
  );
  assert.match(
    daemonCameOnline("0.5.9", since, connected).reason,
    /runs 0.5.8/,
  );
  assert.match(
    daemonCameOnline("0.5.8", Date.now() + 1000, connected).reason,
    /not started/,
  );
});

async function runLiveness(body, env = {}) {
  const root = mkdtempSync(join(tmpdir(), "runner-liveness-"));
  const module = new URL("../dist/execution-host/liveness.js", import.meta.url)
    .href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      // A runner's server keeps its loop alive; this timer stands in for it.
      `setInterval(() => {}, 1000);
       const { startHostLiveness } = await import(${JSON.stringify(module)});
       await startHostLiveness(${JSON.stringify(root)}, "app.foundry.execution.test");
       ${body}`,
    ],
    {
      // Not a test of its own: the runner reports to nobody.
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, ...env },
      stdio: "ignore",
    },
  );
  const [code, signal] = await new Promise((done) =>
    child.once("exit", (...args) => done(args)),
  );
  const { readFileSync } = await import("node:fs");
  const log = readFileSync(join(root, "fatal.log"), "utf8");
  const beat = JSON.parse(readFileSync(join(root, "heartbeat.json"), "utf8"));
  rmSync(root, { recursive: true, force: true });
  return { code, signal, log, beat, pid: child.pid };
}

test("a runner's fatal error is recorded and never hangs its exit", async () => {
  const { signal, log, beat, pid } = await runLiveness(
    `setImmediate(() => { throw new Error("boom in an immediate"); });`,
  );
  assert.equal(signal, "SIGKILL");
  assert.match(log, /uncaught exception: Error: boom in an immediate/);
  assert.equal(beat.pid, pid);
  assert.equal(beat.label, "app.foundry.execution.test");
});

test("a runner whose event loop stays blocked ends itself", async () => {
  const { signal, log } = await runLiveness(
    `setTimeout(() => { for (;;) {} }, 1000);`,
    { FOUNDRY_EXECUTION_STALL_LIMIT_MS: "1000" },
  );
  assert.equal(signal, "SIGKILL");
  assert.match(log, /event loop blocked for \d+ ms; exiting/);
});
