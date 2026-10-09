import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dropsCheck,
  missingWorkspaces,
  redactLogLine,
  runDiagnostics,
  runRepair,
} from "../dist/diagnostics.js";
import { readRegistry, writeRegistry } from "../dist/workspaces.js";

test("log lines leave the device without secrets", () => {
  const line = redactLogLine(
    'GET https://alice:hunter2@relay.example/v1?token=abc123def Authorization: Bearer sk-ant-api03-ABCDEFGHIJKLMNOP "apiKey": "ghp_ABCDEFGHIJKL" mail me at dev@example.com',
  );
  for (const secret of [
    "hunter2",
    "abc123def",
    "sk-ant-api03-ABCDEFGHIJKLMNOP",
    "ghp_ABCDEFGHIJKL",
    "dev@example.com",
  ])
    assert.ok(!line.includes(secret), `${secret} leaked: ${line}`);
  assert.match(line, /relay\.example/, "the host stays readable");
});

test("diagnostics report every check without making model requests", async () => {
  let inspected = 0;
  const report = await runDiagnostics({
    serverURL: "http://127.0.0.1:9",
    socketRoundTrip: async () => 42,
    fetch: async () => new Response("ok", { status: 200 }),
    inspect: async (runtime) => {
      inspected += 1;
      return { runtime, status: "local_login" };
    },
  });
  const ids = report.checks.map((item) => item.id);
  for (const id of [
    "connection.server",
    "connection.socket",
    "connection.drops",
    "connection.proxy",
    "runtime.eventLoop",
    "runtime.memory",
    "runtime.disk",
    "agents.claude",
    "agents.codex",
    "workspaces.missing",
    "skills.scan",
    "chats.sync",
  ])
    assert.ok(ids.includes(id), `missing check ${id}`);
  const socket = report.checks.find((item) => item.id === "connection.socket");
  assert.deepEqual(socket, {
    id: "connection.socket",
    status: "ok",
    values: { ms: 42 },
  });
  assert.ok(Array.isArray(report.logTail));
  assert.ok(report.workerVersion);
  assert.ok(inspected <= 2);
});

test("a failing check reports its error instead of failing the report", async () => {
  const report = await runDiagnostics({
    serverURL: "http://127.0.0.1:9",
    socketRoundTrip: async () => {
      throw new Error("the control socket is not open");
    },
    fetch: async () => {
      throw new Error("connect ECONNREFUSED");
    },
    inspect: async () => {
      throw new Error("boom");
    },
  });
  const server = report.checks.find((item) => item.id === "connection.server");
  assert.equal(server.status, "error");
  assert.match(String(server.values.error), /ECONNREFUSED/);
});

test("forgetting missing workspaces keeps the ones that exist", () => {
  const root = mkdtempSync(join(tmpdir(), "diag-ws-"));
  const kept = join(root, "kept");
  mkdirSync(kept);
  writeRegistry([
    { id: "ws_kept", name: "kept", path: kept, registeredAt: "x" },
    {
      id: "ws_gone",
      name: "gone",
      path: join(root, "gone"),
      registeredAt: "x",
    },
  ]);
  assert.deepEqual(
    missingWorkspaces().map((entry) => entry.id),
    ["ws_gone"],
  );
  const result = runRepair("forget-missing-workspaces", () => {});
  assert.equal(result.values.count, 1);
  assert.deepEqual(
    readRegistry().map((entry) => entry.id),
    ["ws_kept"],
  );
  let rechecked = false;
  runRepair("recheck-agents", () => {
    rechecked = true;
  });
  assert.ok(rechecked);
});

test("drops while the worker was frozen do not blame the network", () => {
  const drop = (maxLagMs) => ({
    openedAt: "2026-10-09T08:00:00Z",
    closedAt: "2026-10-09T08:01:15Z",
    durationMs: 75_000,
    closedBy: "worker",
    sinceServerDataMs: 75_000,
    ...(maxLagMs ? { maxLagMs } : {}),
  });
  const { status, values } = dropsCheck([drop(40), drop(125_000), drop()]);
  assert.equal(status, "warn");
  assert.equal(values.count, 3);
  assert.equal(values.silentServer, 2);
  assert.equal(values.frozenWorker, 1);
  assert.equal(dropsCheck([]).status, "ok");
});
