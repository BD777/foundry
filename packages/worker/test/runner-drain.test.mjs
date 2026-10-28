import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processIdentity } from "../dist/agent-processes.js";
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
  assert.deepEqual(drainDecision(turn, since, since + 60_000), {
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
  // No turn, but a timer or service keeps an old runner busy.
  const quiet = { ...idle, busy: true };
  assert.deepEqual(drainDecision(quiet, since, since + 10, since), {
    action: "wait",
    hold: true,
  });
  assert.deepEqual(
    drainDecision(quiet, since, since + backgroundHoldMs, since),
    { action: "wait", hold: false, waitingFor: "background" },
  );
  // A runner that knows turn boundaries hands its timers over instead.
  assert.deepEqual(
    drainDecision(
      { ...quiet, capabilities: ["drain_switch_v1"] },
      since,
      since + 10,
      since,
    ),
    { action: "switch", mode: "boundary" },
  );
  // Background tasks are never ended by an automatic switch.
  const background = {
    ...quiet,
    capabilities: ["drain_switch_v1"],
    background: ["s3"],
  };
  assert.equal(
    drainDecision(background, since, since + runnerSwitchCapMs + 1, since)
      .action,
    "wait",
  );
});

/** A runner speaking the control protocol; `entry` changes when replaced. */
function fakeRunner(socketPath, capabilities) {
  const identity = processIdentity(process.pid);
  const runner = {
    entry:
      "/runtime/old/node_modules/@bd777/foundry-worker/dist/execution-host/main.js",
    claims: [],
    busy: false,
    requests: [],
    sockets: new Set(),
    capabilities,
  };
  const snapshot = () => ({
    protocol: 1,
    capabilities: runner.capabilities,
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

async function setup(t, capabilities = ["idle_upgrade"]) {
  const root = mkdtempSync(join(tmpdir(), "runner-drain-"));
  const socketPath = join(root, "control.sock");
  const runner = await fakeRunner(socketPath, capabilities);
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
    legacyAlone: () => false,
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
  const { runner, client, replaced } = await setup(t, [
    "idle_upgrade",
    "drain_switch_v1",
  ]);
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
  assert.equal(client.runner().state, "current");
});

test("an older runner busy without turns is switched by switch now directly", async (t) => {
  const { runner, client, replaced } = await setup(t, ["idle_upgrade"]);
  runner.busy = true; // a timer or service the old runner cannot hand over
  await client.refresh();
  assert.equal(replaced.length, 0, "never switched automatically");
  assert.equal(client.runner().state, "pending");
  const result = await client.switchNow([]);
  assert.equal(result.switched, true);
  assert.equal(replaced.length, 1);
  assert.equal(
    runner.requests.some(
      (r) => r.method === "prepare_upgrade" && r.mode === "now",
    ),
    false,
    "an older runner is not asked a mode it does not know",
  );
});
