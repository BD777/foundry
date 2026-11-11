import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { processIdentity } from "../dist/platform/process/agent-processes.js";
import { executionHostPaths } from "../dist/execution-host/paths.js";
import {
  executionHostProtocol,
  hostRolloverCapability,
} from "../dist/execution-host/protocol.js";
import { ExecutionHostFleet } from "../dist/execution-host/fleet.js";
import { adoptStoppedHost } from "../dist/execution-host/adoption.js";
import {
  generationRoot,
  hostWasStopped,
  knownHostRoots,
  markHostStopped,
  seniorHostLive,
  seniorHostPresent,
} from "../dist/execution-host/roots.js";
import {
  adoptionDue,
  hasUnfinishedWork,
} from "../dist/execution-host/adoption.js";
import {
  downgradeBlocker,
  isDowngrade,
} from "../dist/execution-host/rollback.js";
import { SessionTimers } from "../dist/session/tasks/session-timers.js";
import {
  attachSessionWork,
  deferSessionWork,
  resumeSessionWork,
} from "../dist/session-work/supervisor.js";
import { SessionExecutionRegistry } from "../dist/session/session-state.js";
import { ReliableSessionTransport } from "../dist/transport/transport.js";
import { activeCodexThreads } from "../dist/session/session-state.js";
import {
  closeIdleRuntimes,
  residentSessions,
} from "../dist/session/runner/active-runtimes.js";

const serverURL = "http://127.0.0.1:1";
const OLD_ENTRY = "/runtime/old/dist/execution-host/main.js";
const NEW_ENTRY = "/runtime/new/dist/execution-host/main.js";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await pause(20);
  }
  throw new Error("condition not met");
}

/** A host speaking the control protocol, as the real one answers it. */
function fakeHost(root, { entry, version, capable = true }) {
  const identity = processIdentity(process.pid);
  const host = {
    root,
    entry,
    version,
    claims: [],
    resident: [],
    retiring: false,
    requests: [],
    sockets: new Set(),
    alive: true,
    order: [],
  };
  const snapshot = () => ({
    protocol: executionHostProtocol,
    ...(capable
      ? {
          capabilities: [hostRolloverCapability],
          retiring: host.retiring,
          resident: host.resident,
          outbox: 0,
        }
      : {}),
    version: host.version,
    entry: host.entry,
    runtimeStamp: host.entry,
    busy: host.claims.length > 0,
    serverURL,
    pid: process.pid,
    startTime: identity.startTime,
    claims: host.claims,
    background: [],
    ownTurns: [],
  });
  const pinned = (sessionId) =>
    host.claims.some((claim) => claim.sessionId === sessionId) ||
    host.resident.some((entry) => entry.sessionId === sessionId && entry.busy);
  host.server = createServer((socket) => {
    host.sockets.add(socket);
    socket.on("close", () => host.sockets.delete(socket));
    socket.on("error", () => {});
    createInterface({ input: socket }).on("line", (line) => {
      const request = JSON.parse(line);
      const answer = (result) =>
        socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
      const refuse = (error) =>
        socket.write(
          `${JSON.stringify({ id: request.id, error, outcomeUnknown: false })}\n`,
        );
      if (request.token) return answer(snapshot());
      host.requests.push(request);
      host.order.push(request.method);
      switch (request.method) {
        case "snapshot":
          return answer(snapshot());
        case "run": {
          const { session } = request.payload;
          if (host.retiring && !pinned(session.id))
            return refuse(
              "Execution host is retiring; a newer host takes this session.",
            );
          if (
            !host.claims.some(
              (claim) =>
                claim.sessionId === session.id &&
                claim.inputId === session.input.id,
            )
          )
            host.claims.push({
              sessionId: session.id,
              inputId: session.input.id,
            });
          return answer({ status: "active" });
        }
        case "retire":
          host.retiring = request.retiring;
          return answer({ retiring: host.retiring });
        case "release_session":
          if (pinned(request.sessionId)) return answer({ released: false });
          host.resident = host.resident.filter(
            (entry) => entry.sessionId !== request.sessionId,
          );
          return answer({ released: true });
        case "cancel":
          host.claims = host.claims.filter(
            (claim) => claim.sessionId !== request.sessionId,
          );
          return answer({ inputId: request.inputId, stopped: true });
        case "prepare_upgrade":
          return answer({
            ready: request.mode === "now" || !host.claims.length,
          });
        default:
          return answer({});
      }
    });
  });
  host.stop = () => {
    host.alive = false;
    for (const socket of host.sockets) socket.destroy();
    host.server.close();
  };
  return new Promise((done) =>
    host.server.listen(join(root, "control.sock"), () => done(host)),
  );
}

function payload(sessionId, inputId, nativeSessionId) {
  return {
    session: {
      id: sessionId,
      workspaceId: "ws",
      provider: "codex",
      nativeSessionId,
      input: { id: inputId },
    },
  };
}

/** A device whose original host runs the old runtime; the daemon is new. */
async function device(t, oldHost = {}, behaviour = {}) {
  const base = mkdtempSync(join(tmpdir(), "host-rollover-"));
  const oldRoot = join(base, "legacy");
  const newRoot = join(base, "gen-new");
  mkdirSync(oldRoot, { recursive: true });
  const hosts = new Map();
  const stopped = [];
  const markers = new Set();
  const registry = new SessionExecutionRegistry();
  const old = await fakeHost(oldRoot, {
    entry: OLD_ENTRY,
    version: "old",
    ...oldHost,
  });
  hosts.set(oldRoot, old);
  const identity = processIdentity(process.pid);
  const driver = {
    entry: NEW_ENTRY,
    stamp: NEW_ENTRY,
    roots: () => [oldRoot, newRoot],
    rootFor: () => newRoot,
    live: (root) => {
      const host = hosts.get(root);
      return host?.alive
        ? {
            pid: process.pid,
            startTime: identity.startTime,
            entry: host.entry,
            runtimeStamp: host.entry,
          }
        : undefined;
    },
    stopped: (root) => markers.has(root),
    prepare: (root) => {
      mkdirSync(root, { recursive: true });
      return { socket: join(root, "control.sock"), token: "token" };
    },
    start: async (root) => {
      if (behaviour.newHostFails) throw new Error("the new host cannot start");
      hosts.set(
        root,
        await fakeHost(root, { entry: NEW_ENTRY, version: "new" }),
      );
    },
    stop: async (root) => {
      stopped.push(root);
      await behaviour.stopGate;
      hosts.get(root)?.stop();
      markers.add(root);
    },
    reclaim: async () => {},
  };
  const fleet = new ExecutionHostFleet(serverURL, driver, {
    serviceStartMs: 300,
  });
  const transport = new ReliableSessionTransport();
  transport.bind({ readyState: 1, send: () => {} });
  fleet.attach(transport, registry);
  t.after(() => {
    fleet.close();
    for (const host of hosts.values()) host.stop();
    rmSync(base, { recursive: true, force: true });
  });
  const boot = async () => {
    await fleet.start();
    await fleet.open();
  };
  return {
    fleet,
    old,
    hosts,
    stopped,
    markers,
    registry,
    oldRoot,
    newRoot,
    boot,
    newHost: () => hosts.get(newRoot),
  };
}

test("after an update new turns run on the new host while the old one retires", async (t) => {
  const d = await device(t);
  d.old.claims = [{ sessionId: "running", inputId: "r1" }];
  await d.boot();
  assert.ok(d.newHost(), "the daemon started the new runtime's host");
  assert.equal(d.old.retiring, true, "the old host was told to retire");

  await d.fleet.run("/tmp", payload("fresh", "f1"));
  assert.equal(
    d.newHost().requests.filter((r) => r.method === "run").length,
    1,
  );
  assert.equal(d.old.requests.filter((r) => r.method === "run").length, 0);
  // Long past the old switch cap the new turn is still not on the old host.
  await d.fleet.run("/tmp", payload("fresh2", "f2"));
  assert.equal(d.old.requests.filter((r) => r.method === "run").length, 0);
});

test("the old host's turn runs to its end and is steered and cancelled there", async (t) => {
  const d = await device(t);
  d.old.claims = [{ sessionId: "running", inputId: "r1" }];
  await d.boot();
  await d.fleet.refresh();
  assert.deepEqual(d.stopped, [], "a running turn is never stopped");
  assert.equal(d.fleet.owns("running", "r1"), true);

  await d.fleet.steer("running", "r1", "more", []);
  assert.equal(d.old.requests.filter((r) => r.method === "steer").length, 1);
  assert.equal(
    d.newHost().requests.filter((r) => r.method === "steer").length,
    0,
  );
  // A repeated dispatch of that input stays with the host that holds it.
  await d.fleet.run("/tmp", payload("running", "r1"));
  assert.equal(
    d.newHost().requests.filter((r) => r.method === "run").length,
    0,
  );

  const runner = d.fleet.runner();
  assert.equal(runner.state, "pending");
  assert.equal(runner.version, "old");
  assert.equal(runner.targetVersion, "new");
  assert.equal(runner.runningTurns, 1);
  assert.equal(runner.waitingFor, "turns");
  assert.equal(d.fleet.runnerDetail().turns.length, 1);

  await d.fleet.cancel("running", "r1");
  assert.equal(d.old.claims.length, 0);
});

test("the old host is stopped once it drains and the device is current", async (t) => {
  const d = await device(t);
  d.old.claims = [{ sessionId: "running", inputId: "r1" }];
  await d.boot();
  await d.fleet.refresh();
  assert.deepEqual(d.stopped, []);

  d.old.claims = [];
  await d.fleet.refresh();
  await until(() => d.stopped.includes(d.oldRoot));
  assert.ok(d.old.order.includes("prepare_upgrade"));
  assert.equal(d.old.alive, false);
  assert.equal(d.fleet.runner().state, "current");
  assert.deepEqual(d.stopped, [d.oldRoot], "the new host keeps running");
  assert.equal(d.newHost().alive, true);
});

test("the next turn of a session resumes on the new host with its native session id", async (t) => {
  const d = await device(t);
  d.old.resident = [
    { sessionId: "idle", busy: false },
    { sessionId: "working", busy: true },
  ];
  d.old.claims = [{ sessionId: "other", inputId: "o1" }];
  await d.boot();

  await d.fleet.run("/tmp", payload("idle", "i2", "native-1"));
  const run = d.newHost().requests.find((r) => r.method === "run");
  assert.equal(run.payload.session.id, "idle");
  assert.equal(run.payload.session.nativeSessionId, "native-1");
  assert.ok(
    d.old.order.includes("release_session"),
    "the old host closed its idle agent first",
  );
  assert.equal(
    d.old.resident.some((entry) => entry.sessionId === "idle"),
    false,
  );
  assert.equal(d.old.requests.filter((r) => r.method === "run").length, 0);

  // An agent that works keeps its session: closing it would end the work.
  await d.fleet.refresh();
  await d.fleet.run("/tmp", payload("working", "w2", "native-2"));
  assert.equal(d.old.requests.filter((r) => r.method === "run").length, 1);
  assert.equal(
    d.newHost().requests.filter((r) => r.method === "run").length,
    1,
  );
});

test("a host without the rollover capability is routed around, not asked", async (t) => {
  const d = await device(t, { capable: false });
  d.old.claims = [{ sessionId: "running", inputId: "r1" }];
  await d.boot();
  await d.fleet.run("/tmp", payload("fresh", "f1"));
  assert.equal(
    d.newHost().requests.filter((r) => r.method === "run").length,
    1,
  );
  assert.equal(d.old.order.includes("retire"), false);
  assert.equal(d.old.requests.filter((r) => r.method === "run").length, 0);
});

test("a retired host that refuses a turn sends it to the new host", async (t) => {
  const d = await device(t);
  d.old.resident = [{ sessionId: "busy-late", busy: true }];
  await d.boot();
  // The agent finished between the fleet's snapshot and its request.
  d.old.resident = [];
  await d.fleet.run("/tmp", payload("busy-late", "b1"));
  assert.equal(
    d.newHost().requests.filter((r) => r.method === "run").length,
    1,
  );
});

test("hosts of different runtimes have their own sockets, services and state", () => {
  const base = mkdtempSync(join(tmpdir(), "host-roots-"));
  try {
    const a = generationRoot("/runtime/a:1", base);
    const b = generationRoot("/runtime/b:1", base);
    assert.notEqual(a, b);
    assert.equal(a, generationRoot("/runtime/a:1", base), "stable per runtime");
    const pa = executionHostPaths(a);
    const pb = executionHostPaths(b);
    const legacy = executionHostPaths(join(base, "legacy"));
    for (const key of ["socket", "token", "unit", "label", "plist"])
      assert.equal(
        new Set([pa[key], pb[key], legacy[key]]).size,
        3,
        `${key} differs per host`,
      );
    mkdirSync(a);
    mkdirSync(b);
    const roots = knownHostRoots(join(base, "legacy"), base);
    assert.equal(roots[0], join(base, "legacy"));
    assert.deepEqual(roots.slice(1).sort(), [a, b].sort());
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("two hosts' forwarders listen on different ports", async () => {
  const forwarder = pathToFileURL(
    resolve("dist/platform/server-link/server-mcp-forwarder.js"),
  ).href;
  const script = `import {startServerMcpForwarder,serverMcpURL} from ${JSON.stringify(forwarder)};await startServerMcpForwarder("http://127.0.0.1:1");console.log(new URL(serverMcpURL("http://127.0.0.1:1/mcp")).port);process.exit(0)`;
  const port = () =>
    new Promise((done, reject) => {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", script],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("close", () => done(Number(out.trim())));
      child.on("error", reject);
    });
  const [first, second] = await Promise.all([port(), port()]);
  assert.ok(first > 0 && second > 0);
  assert.notEqual(first, second);
});

test("a stopped host's envelopes and unfinished inputs are taken over", () => {
  const root = mkdtempSync(join(tmpdir(), "host-adopt-"));
  try {
    writeFileSync(join(root, "identity.json"), "{}");
    writeFileSync(
      join(root, "claims.json"),
      JSON.stringify({
        "s1/i1": { sessionId: "s1", inputId: "i1", status: "active" },
        "s2/i2": {
          sessionId: "s2",
          inputId: "i2",
          status: "completed",
          completedAt: new Date().toISOString(),
        },
      }),
    );
    mkdirSync(join(root, "outbox"));
    writeFileSync(
      join(root, "outbox", "env_1.json"),
      JSON.stringify({
        id: "env_1",
        type: "session_completed",
        payload: { sessionId: "s2" },
      }),
    );
    const sent = [];
    const adopted = adoptStoppedHost(root, {
      send: (type, payload, id) => (
        sent.push({ type, payload, id }),
        id ?? "x"
      ),
    });
    assert.deepEqual(adopted, { envelopes: 1, interrupted: 1 });
    assert.ok(sent.some((m) => m.id === "env_1"));
    assert.ok(
      sent.some(
        (m) =>
          m.type === "session_completed" &&
          m.payload.sessionId === "s1" &&
          m.payload.error,
      ),
      "the unfinished input is reported as interrupted",
    );
    assert.equal(readdirSync(join(root, "outbox")).length, 0);
    assert.equal(existsSync(join(root, "identity.json")), false);
    // Nothing is reported twice.
    const again = adoptStoppedHost(root, { send: () => assert.fail("resent") });
    assert.deepEqual(again, { envelopes: 0, interrupted: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a retiring host closes idle agents and keeps the ones that work", async () => {
  let closed = 0;
  const thread = (busy) => ({
    isBusy: () => busy,
    close: async () => void closed++,
  });
  activeCodexThreads.set("k-idle", {
    key: "k-idle",
    sessionId: "idle",
    thread: thread(false),
  });
  activeCodexThreads.set("k-busy", {
    key: "k-busy",
    sessionId: "busy",
    thread: thread(true),
  });
  try {
    assert.deepEqual(
      residentSessions().sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
      [
        { sessionId: "busy", busy: true },
        { sessionId: "idle", busy: false },
      ],
    );
    assert.deepEqual(closeIdleRuntimes("busy"), []);
    assert.deepEqual(closeIdleRuntimes(), ["idle"]);
    assert.equal(closed, 1);
    assert.deepEqual(residentSessions(), [{ sessionId: "busy", busy: true }]);
  } finally {
    activeCodexThreads.clear();
  }
});

test("a crashed retiring host that its service restarts is kept and retired again", async (t) => {
  const d = await device(t);
  d.old.claims = [{ sessionId: "running", inputId: "r1" }];
  await d.boot();
  assert.equal(d.registry.isActive("running", "r1"), true);

  // The host dies without being stopped by the daemon: no marker.
  d.old.stop();
  await d.fleet.refresh();
  assert.notEqual(
    d.fleet.runner().state,
    "current",
    "a host its service manager may restart is not forgotten",
  );

  // The service manager restarts it in the same root.
  d.hosts.set(
    d.oldRoot,
    await fakeHost(d.oldRoot, { entry: OLD_ENTRY, version: "old" }),
  );
  await d.fleet.refresh();
  assert.equal(d.hosts.get(d.oldRoot).retiring, true, "retired again");
});

test("a host the daemon stopped is forgotten and its claims leave the registry", async (t) => {
  const d = await device(t);
  d.old.claims = [{ sessionId: "running", inputId: "r1" }];
  await d.boot();
  assert.equal(d.registry.isActive("running", "r1"), true);
  assert.deepEqual(d.registry.activeSessionIds(), ["running"]);

  d.old.stop();
  d.markers.add(d.oldRoot);
  await d.fleet.refresh();
  assert.equal(d.fleet.runner().state, "current");
  assert.equal(d.registry.isActive("running", "r1"), false);
  assert.deepEqual(d.registry.activeSessionIds(), []);
});

test("a live host nobody links (restarted after a crash) is found again", async (t) => {
  const d = await device(t);
  await d.boot();
  await until(() => d.stopped.includes(d.oldRoot));
  await d.fleet.refresh();
  assert.equal(d.fleet.runner().state, "current");
  // A host appears in the original root that the daemon does not link.
  d.markers.delete(d.oldRoot);
  d.hosts.set(
    d.oldRoot,
    await fakeHost(d.oldRoot, { entry: OLD_ENTRY, version: "old" }),
  );
  d.hosts.get(d.oldRoot).claims = [{ sessionId: "late", inputId: "l1" }];
  await d.fleet.refresh();
  assert.equal(d.hosts.get(d.oldRoot).retiring, true);
  assert.equal(d.fleet.owns("late", "l1"), true);
});

test("the old host keeps serving, and is not stopped, while the new host cannot start", async (t) => {
  const d = await device(t, {}, { newHostFails: true });
  await d.fleet.start();
  await d.fleet.open().catch(() => undefined);
  await d.fleet.refresh().catch(() => undefined);
  assert.equal(
    d.old.retiring,
    false,
    "not retired before the new host answers",
  );

  await d.fleet.run("/tmp", payload("fresh", "f1"));
  assert.equal(d.old.requests.filter((r) => r.method === "run").length, 1);

  await d.fleet.refresh().catch(() => undefined);
  assert.deepEqual(d.stopped, [], "the only working host is never stopped");
  assert.equal(d.old.alive, true);
});

test("a host being stopped is not routed to", async (t) => {
  let release;
  const stopGate = new Promise((done) => (release = done));
  const d = await device(t, {}, { stopGate });
  d.old.resident = [{ sessionId: "idle", busy: false }];
  await d.boot();
  await until(() => d.stopped.includes(d.oldRoot));

  // The old host's stop is under way (its link is closed): no error, the
  // session's next turn runs on the new host.
  await d.fleet.run("/tmp", payload("idle", "i2", "native-1"));
  assert.equal(
    d.newHost().requests.filter((r) => r.method === "run").length,
    1,
  );
  release();
  await until(() => d.old.alive === false);
});

/** A root whose host identity is this very (live) process. */
function liveRoot(base, name, startedAt) {
  const root = join(base, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "identity.json"),
    JSON.stringify({
      pid: process.pid,
      startTime: processIdentity(process.pid).startTime,
      ...(startedAt === undefined ? {} : { startedAt }),
    }),
  );
  return root;
}
function deadRoot(base, name) {
  const root = join(base, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "identity.json"),
    JSON.stringify({ pid: 2 ** 22 + 7, startTime: "gone" }),
  );
  return root;
}

test("two hosts that start together do not both wait for each other", () => {
  const base = mkdtempSync(join(tmpdir(), "host-senior-"));
  try {
    const a = liveRoot(base, "a", 1000);
    const b = liveRoot(base, "b", 1000);
    const roots = [a, b];
    const waits = [
      seniorHostLive({ root: a, startedAt: 1000 }, roots),
      seniorHostLive({ root: b, startedAt: 1000 }, roots),
    ];
    assert.equal(waits.filter(Boolean).length, 1, "exactly one stands by");
    // A host before rollover (no startedAt) is senior to every new one.
    const legacy = liveRoot(base, "legacy");
    assert.equal(
      seniorHostLive({ root: a, startedAt: 1000 }, [legacy, a]),
      true,
    );
    assert.equal(
      seniorHostLive({ root: legacy, startedAt: 0 }, [legacy, a]),
      false,
    );
    // A dead senior is not waited for.
    assert.equal(
      seniorHostLive({ root: a, startedAt: 1000 }, [deadRoot(base, "d"), a]),
      false,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a dead host is adopted once stopped by the daemon, a crashed one only if it stays dead", () => {
  const base = mkdtempSync(join(tmpdir(), "host-adoption-due-"));
  try {
    const crashed = deadRoot(base, "crashed");
    const deadSince = new Map();
    assert.equal(adoptionDue(crashed, deadSince, 1_000), false, "first seen");
    assert.equal(
      adoptionDue(crashed, deadSince, 1_000 + 5_000),
      false,
      "its service manager is restarting it",
    );
    assert.equal(adoptionDue(crashed, deadSince, 1_000 + 61_000), true);

    // A restart (live again) resets the wait.
    const restarted = deadRoot(base, "restarted");
    adoptionDue(restarted, deadSince, 0);
    writeFileSync(
      join(restarted, "identity.json"),
      JSON.stringify({
        pid: process.pid,
        startTime: processIdentity(process.pid).startTime,
      }),
    );
    assert.equal(adoptionDue(restarted, deadSince, 120_000), false);
    assert.equal(deadSince.has(restarted), false);

    // The daemon stopped the service: adopt at once.
    const stopped = deadRoot(base, "stopped");
    markHostStopped(stopped);
    assert.equal(adoptionDue(stopped, new Map(), 0), true);

    // A marker from before the host last started does not count.
    const stale = deadRoot(base, "stale");
    markHostStopped(stale);
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(stale, "identity.json"), later, later);
    assert.equal(hostWasStopped(stale), false);
    assert.equal(adoptionDue(stale, new Map(), 0), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("timers set while standing by reach the file when the host takes over", () => {
  const base = mkdtempSync(join(tmpdir(), "host-timers-"));
  try {
    const path = join(base, "session-timers.json");
    writeFileSync(
      path,
      JSON.stringify({
        sessions: [
          { sessionId: "older", nativeSessionId: "n0", timers: [{ id: "t0" }] },
          { sessionId: "both", nativeSessionId: "n1", timers: [{ id: "old" }] },
        ],
      }),
    );
    const timers = new SessionTimers();
    timers.record("both", "n1", [{ id: "new" }]);
    timers.record("standby-only", "n2", [{ id: "t2" }]);
    timers.load(path);
    const kept = Object.fromEntries(
      timers.kept().map((session) => [session.sessionId, session.timers]),
    );
    assert.deepEqual(kept.both, [{ id: "new" }], "memory wins");
    assert.ok(kept.older, "the kept one is read");
    const saved = JSON.parse(readFileSync(path, "utf8")).sessions;
    assert.deepEqual(saved.map((s) => s.sessionId).sort(), [
      "both",
      "older",
      "standby-only",
    ]);
    assert.deepEqual(saved.find((s) => s.sessionId === "both").timers, [
      { id: "new" },
    ]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("session work attaches deferred in standby survive the host and are replayed by the next owner", () => {
  const base = mkdtempSync(join(tmpdir(), "host-defer-"));
  try {
    const own = join(base, "own.json");
    const older = join(base, "older.json");
    writeFileSync(
      older,
      JSON.stringify([
        {
          session: { id: "from-b", workspaceId: "ws" },
          workspacePath: "/tmp/ws",
        },
      ]),
    );
    deferSessionWork(own);
    attachSessionWork(
      { id: "mine", workspaceId: "ws", deviceId: "dev", nativeSessionId: "n" },
      "/tmp/ws",
    );
    attachSessionWork({ id: "role", role: "child", workspaceId: "ws" }, "/tmp");
    const kept = JSON.parse(readFileSync(own, "utf8"));
    assert.deepEqual(
      kept.map((entry) => entry.session.id),
      ["mine"],
      "written to the host's own file, child roles left out",
    );
    resumeSessionWork([older, join(base, "missing.json")]);
    assert.equal(existsSync(own), false);
    assert.equal(
      existsSync(older),
      false,
      "the stopped host's file is consumed",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("going back to an older Worker is refused while hosts run beside the original", () => {
  const base = mkdtempSync(join(tmpdir(), "host-rollback-"));
  try {
    const original = liveRoot(base, "execution-host");
    const generation = liveRoot(base, "gen", 5);
    assert.equal(isDowngrade("0.1.5", "0.1.9"), true);
    assert.equal(isDowngrade("0.1.9", "0.1.5"), false);
    assert.equal(isDowngrade("0.1.5", "0.1.5"), false);
    assert.equal(isDowngrade("weird", "0.1.5"), false);

    const roots = [original, generation];
    assert.match(
      downgradeBlocker("0.1.5", "0.1.9", roots, original),
      /FOUNDRY_STOP_HOSTS_FOR_DOWNGRADE/,
    );
    assert.equal(
      downgradeBlocker("0.1.9", "0.1.5", roots, original),
      undefined,
      "an update is never blocked",
    );
    assert.equal(
      downgradeBlocker("0.1.5", "0.1.9", [original], original),
      undefined,
      "one host in the original root is what the older Worker expects",
    );
    assert.equal(
      downgradeBlocker(
        "0.1.5",
        "0.1.9",
        [original, deadRoot(base, "d")],
        original,
      ),
      undefined,
      "a host that no longer runs does not block",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a senior host that crashed is waited for until its service manager gives up", () => {
  const base = mkdtempSync(join(tmpdir(), "host-senior-crash-"));
  try {
    const me = join(base, "me");
    mkdirSync(me);
    const senior = deadRoot(base, "senior");
    const roots = [senior, me];
    const self = { root: me, startedAt: 5_000 };
    const deadSince = new Map();
    assert.equal(
      seniorHostPresent(self, deadSince, 1_000, 60_000, roots),
      true,
      "just died: it may be restarted, do not take over",
    );
    assert.equal(
      seniorHostPresent(self, deadSince, 1_000 + 30_000, 60_000, roots),
      true,
    );
    assert.equal(
      seniorHostPresent(self, deadSince, 1_000 + 61_000, 60_000, roots),
      false,
      "it stayed dead",
    );
    // The daemon stopped it: nothing will restart it, take over at once.
    markHostStopped(senior);
    assert.equal(seniorHostPresent(self, new Map(), 0, 60_000, roots), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a stopped host's unfinished work is found, so its identity is kept", () => {
  const base = mkdtempSync(join(tmpdir(), "host-unfinished-"));
  try {
    const clean = join(base, "clean");
    mkdirSync(clean);
    assert.equal(hasUnfinishedWork(clean), false);
    writeFileSync(
      join(clean, "claims.json"),
      JSON.stringify({
        a: { sessionId: "s", inputId: "i", status: "completed" },
      }),
    );
    assert.equal(hasUnfinishedWork(clean), false);
    const busy = join(base, "busy");
    mkdirSync(busy);
    writeFileSync(
      join(busy, "claims.json"),
      JSON.stringify({ a: { sessionId: "s", inputId: "i", status: "active" } }),
    );
    assert.equal(hasUnfinishedWork(busy), true);
    const unsent = join(base, "unsent");
    mkdirSync(join(unsent, "outbox"), { recursive: true });
    writeFileSync(
      join(unsent, "outbox", "env_1.json"),
      JSON.stringify({ id: "env_1", type: "x", payload: {} }),
    );
    assert.equal(hasUnfinishedWork(unsent), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
