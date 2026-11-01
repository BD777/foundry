import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processIdentity } from "../dist/agent-processes.js";
import { executionHostPaths } from "../dist/execution-host/paths.js";
import {
  ExecutionHostClient,
  RunnerTurnsChangedError,
} from "../dist/execution-host/client.js";
import {
  drainDecision,
  runnerSwitchCapMs,
  backgroundHoldMs,
} from "../dist/execution-host/drain.js";
import { SessionExecutionRegistry } from "../dist/session-state.js";
import { ReliableSessionTransport } from "../dist/transport.js";
import { isNotSteerableError } from "../dist/session-control.js";

const serverURL = "http://127.0.0.1:1";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await pause(20);
  }
  throw new Error("condition not met");
}

test("drain policy: idle switches, turns hold until the cap, background releases", () => {
  const since = 1_000_000;
  const idle = { claims: [], background: [], ownTurns: [], busy: false };
  assert.deepEqual(drainDecision(idle, since, since), {
    action: "switch",
    mode: "idle",
  });
  const turn = {
    ...idle,
    busy: true,
    claims: [{ sessionId: "s1", inputId: "i1" }],
  };
  assert.deepEqual(drainDecision(turn, since, since + runnerSwitchCapMs / 2), {
    action: "wait",
    hold: true,
  });
  // Past the cap the running turn is never stopped: new turns go to the
  // old runner again and it switches when no turn runs.
  assert.deepEqual(drainDecision(turn, since, since + runnerSwitchCapMs), {
    action: "wait",
    hold: false,
    waitingFor: "turns",
  });
  const own = { ...idle, busy: true, ownTurns: ["s2"] };
  assert.equal(drainDecision(own, since, since).hold, true);
  // No turn, but a timer or service keeps the runner busy: it hands its
  // timers over at the turn boundary.
  const quiet = { ...idle, busy: true };
  assert.deepEqual(drainDecision(quiet, since, since + 10, since), {
    action: "switch",
    mode: "boundary",
  });
  // Background tasks hold new turns a while, and are never ended by an
  // automatic switch.
  const background = { ...quiet, background: ["s3"] };
  assert.deepEqual(drainDecision(background, since, since + 10, since), {
    action: "wait",
    hold: true,
  });
  assert.deepEqual(
    drainDecision(background, since, since + backgroundHoldMs, since),
    { action: "wait", hold: false, waitingFor: "background" },
  );
  assert.equal(
    drainDecision(background, since, since + runnerSwitchCapMs + 1, since)
      .action,
    "wait",
  );
});

/** A runner speaking the control protocol; `entry` changes when replaced. */
function fakeRunner(socketPath) {
  const identity = processIdentity(process.pid);
  const runner = {
    entry:
      "/runtime/old/node_modules/@bd777/foundry-worker/dist/execution-host/main.js",
    claims: [],
    busy: false,
    requests: [],
    sockets: new Set(),
    version: "old",
  };
  const snapshot = () => ({
    protocol: 1,
    capabilities: [],
    version: runner.version,
    entry: runner.entry,
    runtimeStamp: runner.entry,
    busy: runner.busy || runner.claims.length > 0,
    serverURL,
    pid: process.pid,
    startTime: identity.startTime,
    claims: runner.claims,
    background: [],
    ownTurns: [],
  });
  runner.server = createServer((socket) => {
    runner.sockets.add(socket);
    socket.on("close", () => runner.sockets.delete(socket));
    socket.on("error", () => {});
    createInterface({ input: socket }).on("line", (line) => {
      const request = JSON.parse(line);
      const answer = (result) =>
        socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
      if (request.token) return answer(snapshot());
      runner.requests.push(request);
      if (request.method === "snapshot") return answer(snapshot());
      if (request.method === "run") {
        const { session } = request.payload;
        runner.claims.push({
          sessionId: session.id,
          inputId: session.input.id,
        });
        return answer({ status: "active" });
      }
      if (request.method === "cancel") {
        runner.claims = runner.claims.filter(
          (claim) => claim.sessionId !== request.sessionId,
        );
        return answer({ inputId: request.inputId, stopped: true });
      }
      if (request.method === "prepare_upgrade")
        return answer({
          ready: request.mode === "now" || !snapshot().busy,
        });
      answer({});
    });
  });
  runner.replace = () => {
    runner.entry =
      "/runtime/new/node_modules/@bd777/foundry-worker/dist/execution-host/main.js";
    runner.version = "new";
    runner.claims = [];
    runner.busy = false;
    for (const socket of runner.sockets) socket.destroy();
  };
  return new Promise((done) =>
    runner.server.listen(socketPath, () => done(runner)),
  );
}

function payload(sessionId, inputId) {
  return {
    session: {
      id: sessionId,
      workspaceId: "ws",
      provider: "codex",
      input: { id: inputId },
    },
  };
}

async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "runner-drain-"));
  const socketPath = join(root, "control.sock");
  const runner = await fakeRunner(socketPath);
  const replaced = [];
  const client = new ExecutionHostClient(socketPath, "token", serverURL, {
    entry:
      "/runtime/new/node_modules/@bd777/foundry-worker/dist/execution-host/main.js",
    stamp:
      "/runtime/new/node_modules/@bd777/foundry-worker/dist/execution-host/main.js",
    start: async () => {},
    stop: async () => {
      replaced.push(Date.now());
      runner.replace();
    },
  });
  const sent = [];
  const transport = new ReliableSessionTransport();
  transport.bind({
    readyState: 1,
    send: (data) => sent.push(JSON.parse(data)),
  });
  client.attach(transport, new SessionExecutionRegistry());
  const reports = [];
  t.after(() => {
    client.close();
    runner.server.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { runner, client, sent, replaced, reports };
}

test("new turns wait for the new runner while a turn runs, then go to it", async (t) => {
  const { runner, client, sent, replaced } = await setup(t);
  runner.claims = [{ sessionId: "running", inputId: "r1" }];
  const reports = [];
  client.setRunnerSink((value) => reports.push(value));
  await client.refresh();
  assert.equal(client.runner().state, "pending");
  assert.equal(client.runner().runningTurns, 1);
  assert.equal(client.runner().version, "old");
  assert.ok(client.runner().deadline);

  await client.run("/tmp", payload("queued", "q1"));
  assert.equal(
    runner.requests.filter((r) => r.method === "run").length,
    0,
    "the old runner never receives the new turn",
  );
  assert.equal(client.runner().heldTurns, 1);
  assert.equal(client.owns("queued", "q1"), true);
  assert.equal(client.hasSession("queued"), true);
  assert.ok(reports.some((value) => value.heldTurns === 1));

  // Its messages are held by the server until the turn starts.
  await assert.rejects(client.steer("queued", "m1", "hello", []), (error) =>
    isNotSteerableError(error),
  );

  // The running turn ends: the runner switches and takes the held turn.
  runner.claims = [];
  await client.refresh();
  await until(() =>
    runner.requests.some(
      (r) => r.method === "run" && r.payload.session.id === "queued",
    ),
  );
  assert.equal(replaced.length, 1, "switched once");
  assert.equal(client.runner().state, "current");
  assert.equal(client.runner().version, "new");
  assert.equal(client.runner().heldTurns, 0);
  assert.equal(
    sent.filter((e) => e.type === "session_completed").length,
    0,
    "nothing was stopped",
  );
});

test("a held turn canceled before it started is reported, never run", async (t) => {
  const { runner, client, sent } = await setup(t);
  runner.claims = [{ sessionId: "running", inputId: "r1" }];
  await client.refresh();
  await client.run("/tmp", payload("queued", "q1"));
  const outcome = await client.cancel("queued", "q1");
  assert.equal(outcome.stopped, true);
  const completed = sent.find((e) => e.type === "session_completed");
  assert.equal(completed.payload.sessionId, "queued");
  assert.match(completed.payload.error, /canceled before it started/);
  assert.equal(client.runner().heldTurns, 0);
  runner.claims = [];
  await client.refresh();
  await pause(50);
  assert.equal(
    runner.requests.filter((r) => r.method === "run").length,
    0,
    "a canceled turn never reaches a runner",
  );
});

test("switch now stops exactly the reviewed turns, refuses an unreviewed one", async (t) => {
  const { runner, client, replaced } = await setup(t);
  runner.claims = [{ sessionId: "long", inputId: "l1" }];
  await client.refresh();
  assert.deepEqual(client.runnerDetail().turns, [
    { sessionId: "long", inputId: "l1" },
  ]);
  await assert.rejects(
    client.switchNow([]),
    (error) => error instanceof RunnerTurnsChangedError,
  );
  assert.equal(
    runner.requests.filter((r) => r.method === "cancel").length,
    0,
    "nothing is stopped when the list changed",
  );
  assert.equal(replaced.length, 0);
  const result = await client.switchNow([{ sessionId: "long", inputId: "l1" }]);
  assert.equal(result.switched, true);
  assert.deepEqual(
    runner.requests
      .filter((r) => r.method === "cancel")
      .map((r) => [r.sessionId, r.inputId]),
    [["long", "l1"]],
  );
  assert.equal(replaced.length, 1);
  await until(() => client.runner().state === "current");
});

test("switch now answers once the new runner started, and waits while it recovers (DEV-072)", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "runner-slow-"));
  const socketPath = join(root, "control.sock");
  const runner = await fakeRunner(socketPath);
  runner.busy = true; // a timer or service: the runner refuses an idle switch
  // The new runner beats from its first moment but opens its socket only
  // after a recovery that outlasts the base wait (a device took 107 s).
  const beat = () => {
    const paths = executionHostPaths();
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(
      join(paths.root, "heartbeat.json"),
      JSON.stringify({
        pid: process.pid,
        startTime: processIdentity(process.pid).startTime,
        at: new Date().toISOString(),
      }),
    );
  };
  let opened;
  const client = new ExecutionHostClient(
    socketPath,
    "token",
    serverURL,
    {
      entry:
        "/runtime/new/node_modules/@bd777/foundry-worker/dist/execution-host/main.js",
      stamp:
        "/runtime/new/node_modules/@bd777/foundry-worker/dist/execution-host/main.js",
      stop: async () => {
        runner.replace();
        await new Promise((done) => runner.server.close(() => done()));
      },
      start: async () => {
        beat();
        opened = pause(1200).then(
          () => new Promise((done) => runner.server.listen(socketPath, done)),
        );
      },
    },
    { serviceStartMs: 200 },
  );
  client.attach(new ReliableSessionTransport(), new SessionExecutionRegistry());
  t.after(() => {
    client.close();
    runner.server.close();
    rmSync(root, { recursive: true, force: true });
  });
  await client.refresh();
  assert.equal(client.runner().state, "pending");
  const startedAt = Date.now();
  const result = await client.switchNow([]);
  assert.equal(result.switched, true, "the owner hears it switched");
  assert.ok(Date.now() - startedAt < 1000, "without waiting for recovery");
  assert.equal(client.runner().state, "switching");
  await opened;
  await until(() => client.runner().state === "current");
  assert.equal(client.runner().version, "new");
});

test("a busy device's new turn runs within the short hold, and a newer release never re-arms it (DEV-072)", async (t) => {
  const { runner, client } = await setup(t);
  runner.claims = [{ sessionId: "busy", inputId: "b1" }];
  // A switch has been pending past the hold since an earlier release.
  const paths = executionHostPaths();
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(
    join(paths.root, "switch.json"),
    JSON.stringify({
      stamp:
        "/runtime/older/node_modules/@bd777/foundry-worker/dist/execution-host/main.js",
      since: Date.now() - runnerSwitchCapMs - 1000,
    }),
  );
  t.after(() => rmSync(join(paths.root, "switch.json"), { force: true }));
  await client.refresh();
  assert.equal(client.runner().state, "pending");
  const startedAt = Date.now();
  await client.run("/tmp", payload("person", "p1"));
  assert.ok(
    runner.requests.some(
      (r) => r.method === "run" && r.payload.session.id === "person",
    ),
    "the new turn went to the running runner at once",
  );
  assert.ok(Date.now() - startedAt < 2000);
  assert.equal(client.runner().heldTurns, 0);
  assert.ok(runnerSwitchCapMs <= 60_000, "a hold is never minutes");
});
