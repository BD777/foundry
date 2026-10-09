import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  readSelfUpdateRecord,
  readWorkerUpdateStatus,
  recordSelfUpdateEnd,
  recordSelfUpdateStep,
  selfUpdateLogMarker,
  selfUpdateStatusPath,
  selfUpdateStatusVariable,
  writeSelfUpdateRecord,
} from "../dist/self-update-status.js";
import { serverWorkerRelease } from "../dist/worker-install.js";
import { watchSelfUpdateFailure } from "../dist/worker-self-update.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "self-update-status-"));
  return { status: join(dir, "status.json"), log: join(dir, "update.log") };
}

/** Runs `body` with the update command's status variable set to `path`. */
async function asRequestedUpdate(path, body) {
  const before = process.env[selfUpdateStatusVariable];
  process.env[selfUpdateStatusVariable] = path;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env[selfUpdateStatusVariable];
    else process.env[selfUpdateStatusVariable] = before;
  }
}

test("the updater asks again after a reset, a stall and a 503, logging each retry", async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (requests === 1) {
      request.socket.destroy();
      return;
    }
    if (requests === 2) return; // never answers
    if (requests === 3) {
      response.statusCode = 503;
      response.end("restarting");
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ source: "npm" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { status } = scratch();
  const logged = [];
  const log = console.log;
  console.log = (line) => logged.push(String(line));
  try {
    const release = await asRequestedUpdate(status, () =>
      serverWorkerRelease(base, [5, 5, 5], 300),
    );
    assert.deepEqual(release, { source: "npm" });
  } finally {
    console.log = log;
    server.closeAllConnections();
    server.close();
  }
  assert.equal(requests, 4);
  assert.equal(logged.length, 3);
  assert.match(logged[0], /trying again in 0\.005 s \(attempt 2 of 4\)/);
  assert.match(logged[2], /HTTP 503/);
  // The status the worker reports says what the step waits on.
  const record = readSelfUpdateRecord(status);
  assert.equal(record.step, "checking");
  assert.match(record.detail, /attempt 4 of 4/);
});

test("the updater gives up after its retries with the reason", async () => {
  const server = createServer((request) => request.socket.destroy());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const log = console.log;
  console.log = () => {};
  try {
    await assert.rejects(
      serverWorkerRelease(base, [1, 1], 300),
      /could not ask .* which worker it serves \(fetch failed/,
    );
  } finally {
    console.log = log;
    server.close();
  }
});

test("a failed update command records its failure for the worker", () => {
  const { status } = scratch();
  // No runtime installed in the scratch state root: the update fails.
  const run = spawnSync(process.execPath, [cli, "update"], {
    encoding: "utf8",
    env: { ...process.env, [selfUpdateStatusVariable]: status },
  });
  assert.notEqual(run.status, 0);
  const record = readSelfUpdateRecord(status);
  assert.equal(record.state, "failed");
  assert.equal(record.exitCode, 1);
  assert.match(record.error, /no worker installed/);
});

test("an update run by hand records nothing", () => {
  const { status } = scratch();
  recordSelfUpdateStep("checking");
  recordSelfUpdateEnd({ ok: false, exitCode: 1, error: "x" });
  assert.equal(readSelfUpdateRecord(status), undefined);
});

test("the worker answers a status probe from the update's record and log", async () => {
  const { status, log } = scratch();
  const startedAt = new Date().toISOString();
  writeFileSync(
    log,
    `Updated 0.5.6 → 0.5.7 and restarted the worker.\n\n${selfUpdateLogMarker}${startedAt} ===\nUsing --token abc123 Authorization: Bearer s3cr3t\nERROR [E5001] COMMAND_FAILED\n`,
  );
  // Started, before the update command writes anything.
  writeSelfUpdateRecord(
    { state: "running", step: "starting", startedAt, updatedAt: startedAt },
    status,
  );
  assert.equal(
    readWorkerUpdateStatus(Date.now(), status, log).state,
    "running",
  );
  assert.equal(
    readWorkerUpdateStatus(Date.now() + 120_000, status, log).state,
    "none",
  );
  await asRequestedUpdate(status, async () => {
    recordSelfUpdateStep("downloading", { version: "0.5.8" });
    const running = readWorkerUpdateStatus(Date.now(), status, log);
    assert.equal(running.state, "running");
    assert.equal(running.step, "downloading");
    assert.equal(running.version, "0.5.8");
    assert.equal(typeof running.elapsedMs, "number");
    recordSelfUpdateEnd({ ok: false, exitCode: 1, error: "npm failed" });
    // A run that handed over keeps the failure the other run recorded.
    recordSelfUpdateEnd({ ok: false, exitCode: 7, error: "exited" });
  });
  const failed = readWorkerUpdateStatus(Date.now(), status, log);
  assert.equal(failed.state, "failed");
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.error, "npm failed");
  assert.equal(failed.step, "downloading");
  // Only this update's lines, secrets redacted.
  assert.equal(failed.logTail.length, 2);
  assert.doesNotMatch(failed.logTail[0], /abc123|s3cr3t/);
  assert.equal(failed.logTail[1], "ERROR [E5001] COMMAND_FAILED");
});

test("an update whose process is gone without an outcome reads as none", () => {
  const { status, log } = scratch();
  const gone = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
  const now = new Date().toISOString();
  writeSelfUpdateRecord(
    {
      state: "running",
      step: "installing",
      startedAt: now,
      updatedAt: now,
      pid: gone,
    },
    status,
  );
  appendFileSync(log, "installing\n");
  const answer = readWorkerUpdateStatus(Date.now(), status, log);
  assert.equal(answer.state, "none");
  assert.equal(answer.step, "installing");
  assert.equal(
    readWorkerUpdateStatus(Date.now(), join(status, "x")).state,
    "none",
  );
});

test("the worker reports a failure as soon as the update records it", async () => {
  // watchSelfUpdateFailure reads the stack's own (scratch) status file.
  const path = selfUpdateStatusPath();
  const now = new Date().toISOString();
  writeSelfUpdateRecord(
    {
      state: "running",
      step: "checking",
      startedAt: now,
      updatedAt: now,
      pid: process.pid,
    },
    path,
  );
  const reported = new Promise((resolve) => {
    const stop = watchSelfUpdateFailure((status) => {
      stop();
      resolve(status);
    }, 10);
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  writeSelfUpdateRecord(
    {
      ...JSON.parse(readFileSync(path, "utf8")),
      state: "failed",
      exitCode: 1,
      error: "could not ask the server which worker it serves",
    },
    path,
  );
  // The watcher's timer is unref'd (it must not keep a worker alive), so
  // hold the event loop open while waiting for it.
  const keepAlive = setInterval(() => undefined, 1000);
  const status = await reported.finally(() => clearInterval(keepAlive));
  assert.equal(status.state, "failed");
  assert.match(status.error, /which worker it serves/);
});
