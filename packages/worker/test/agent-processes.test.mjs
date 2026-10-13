import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  processIdentity,
  reapLeftoverAgentProcesses,
} from "../dist/agent-processes.js";

const dist = resolve(fileURLToPath(new URL("../dist", import.meta.url)));

/** A process that is running, not one that ended and waits to be reaped. */
function running(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false;
  }
}

async function waitFor(what, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting: ${what}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

/**
 * A fake agent CLI: starts a "tool" of its own, writes both pids to the file
 * it is given and runs until stopped.
 */
function fakeAgent(dir) {
  const source = `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const tool = spawn("sleep", ["300"], { stdio: "ignore" });
writeFileSync(process.argv[2], JSON.stringify({ agent: process.pid, tool: tool.pid }));
setInterval(() => {}, 1000);
`;
  const path = join(dir, "fake-agent.mjs");
  writeFileSync(path, `#!${process.execPath}\n${source}`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * A fake worker: supervises agent processes, then (with "start") starts one
 * as the Claude SDK would through claudeAgentSpawn and one as the Codex SDK
 * would through codexAgentExecutable's launcher.
 */
function fakeWorker(dir) {
  const path = join(dir, "fake-worker.mjs");
  writeFileSync(
    path,
    `import { spawn } from "node:child_process";
const [dist, role, agent, out] = process.argv.slice(2);
const { superviseAgentProcesses, claudeAgentSpawn, codexAgentExecutable } =
  await import(dist + "/agent-processes.js");
await superviseAgentProcesses();
if (role === "start") {
  claudeAgentSpawn()({
    command: process.execPath,
    args: [agent, out + "/claude.json"],
    env: process.env,
    signal: new AbortController().signal,
  });
  spawn(codexAgentExecutable(agent), [out + "/codex.json"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}
console.log("ready");
setInterval(() => {}, 1000);
`,
  );
  return path;
}

async function startWorker(script, role, agent, out, stateRoot) {
  const worker = spawn(process.execPath, [script, dist, role, agent, out], {
    env: { ...process.env, FOUNDRY_STATE_ROOT: stateRoot },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = createInterface({ input: worker.stdout });
  await new Promise((ready, failed) => {
    lines.on("line", (line) => line === "ready" && ready());
    worker.once("exit", (code) => failed(new Error(`worker exited ${code}`)));
  });
  return worker;
}

function pids(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "agent-processes-"));
  const stateRoot = join(dir, "state");
  mkdirSync(stateRoot);
  return { dir, stateRoot, registry: join(stateRoot, "agent-processes") };
}

function cleanup(...list) {
  for (const pid of list)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone.
    }
}

test("a worker told to stop stops its agents and what they started", async (t) => {
  const { dir, stateRoot, registry } = scratch();
  const agent = fakeAgent(dir);
  const worker = await startWorker(
    fakeWorker(dir),
    "start",
    agent,
    dir,
    stateRoot,
  );
  await waitFor("both agents", () =>
    Boolean(pids(join(dir, "claude.json")) && pids(join(dir, "codex.json"))),
  );
  const claude = pids(join(dir, "claude.json"));
  const codex = pids(join(dir, "codex.json"));
  const all = [claude.agent, claude.tool, codex.agent, codex.tool];
  t.after(() => cleanup(...all));
  await waitFor(
    "both recorded",
    () =>
      readdirSync(registry).filter((name) => name.endsWith(".json")).length ===
      2,
  );
  assert.ok(all.every(running));

  worker.kill("SIGTERM");
  const [, signal] = await new Promise((done) =>
    worker.once("exit", (...end) => done(end)),
  );
  assert.equal(signal, "SIGTERM", "the worker still ends by the signal");
  await waitFor("agents and tools stopped", () => !all.some(running));
  assert.deepEqual(
    readdirSync(registry).filter((name) => name.endsWith(".json")),
    [],
  );
});

test("a killed worker's agents are stopped: Codex's at once, the rest by the next worker", async (t) => {
  const { dir, stateRoot, registry } = scratch();
  const agent = fakeAgent(dir);
  const script = fakeWorker(dir);
  const first = await startWorker(script, "start", agent, dir, stateRoot);
  await waitFor("both agents", () =>
    Boolean(pids(join(dir, "claude.json")) && pids(join(dir, "codex.json"))),
  );
  const claude = pids(join(dir, "claude.json"));
  const codex = pids(join(dir, "codex.json"));
  t.after(() => cleanup(claude.agent, claude.tool, codex.agent, codex.tool));
  await waitFor(
    "both recorded",
    () =>
      readdirSync(registry).filter((name) => name.endsWith(".json")).length ===
      2,
  );

  // No handler runs: what the worker started outlives it...
  first.kill("SIGKILL");
  await new Promise((done) => first.once("exit", done));
  // ...but the Codex host sees its worker go and stops its group.
  await waitFor(
    "the Codex agent stopped by its host",
    () => !running(codex.agent) && !running(codex.tool),
  );
  assert.ok(running(claude.agent) && running(claude.tool), "left running");

  const next = await startWorker(script, "reap", agent, dir, stateRoot);
  t.after(() => next.kill("SIGKILL"));
  assert.ok(
    !running(claude.agent) && !running(claude.tool),
    "the next worker stopped them before it was ready",
  );
  assert.deepEqual(
    readdirSync(registry).filter((name) => name.endsWith(".json")),
    [],
  );
});

test("startup reaping stops only recorded processes that are still the ones recorded", async (t) => {
  const { dir, registry } = scratch();
  mkdirSync(registry);
  const agent = fakeAgent(dir);
  const started = [];
  const startAgent = async (name) => {
    const out = join(dir, `${name}.json`);
    const child = spawn(process.execPath, [agent, out], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    await waitFor(name, () => Boolean(pids(out)));
    const both = pids(out);
    started.push(both.agent, both.tool);
    return { ...both, argv: [process.execPath, agent, out] };
  };
  t.after(() => cleanup(...started));
  const ended = spawnSync("true");
  const goneWorker = { pid: ended.pid, startTime: "a worker that ended" };
  const me = processIdentity(process.pid);
  const record = (target, fields) =>
    writeFileSync(
      join(registry, `${target.agent}.json`),
      JSON.stringify({
        pid: target.agent,
        startTime: processIdentity(target.agent).startTime,
        argv: target.argv,
        owner: goneWorker,
        ...fields,
      }),
    );

  const leftover = await startAgent("leftover");
  record(leftover, {});
  const reused = await startAgent("reused-pid");
  record(reused, { startTime: "another process that had this pid" });
  const otherCommand = await startAgent("other-command");
  record(otherCommand, { argv: ["codex", "exec", "--experimental-json"] });
  const liveWorkers = await startAgent("live-worker");
  record(liveWorkers, {
    owner: { pid: process.pid, startTime: me.startTime },
  });
  const unrecorded = await startAgent("unrecorded");

  const reaped = await reapLeftoverAgentProcesses(registry, 2000);
  assert.deepEqual(reaped, [leftover.agent]);
  await waitFor(
    "the leftover and its tool stopped",
    () => !running(leftover.agent) && !running(leftover.tool),
  );
  for (const kept of [reused, otherCommand, liveWorkers, unrecorded])
    assert.ok(running(kept.agent) && running(kept.tool), `${kept.argv[2]}`);
  assert.deepEqual(readdirSync(registry), [`${liveWorkers.agent}.json`]);
});

test("a child whose prompt cannot be sent is killed when it ignores TERM", async (t) => {
  const { sendPrompt } = await import(dist + "/utils.js");
  const child = spawn(
    process.execPath,
    [
      "-e",
      'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);',
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  t.after(() => child.kill("SIGKILL"));
  await new Promise((ready) => child.stdout.once("data", ready));
  const exited = new Promise((done) =>
    child.once("exit", (_code, signal) => done(signal)),
  );

  t.mock.timers.enable({ apis: ["setTimeout"] });
  sendPrompt(child, "prompt");
  child.stdin.emit(
    "error",
    Object.assign(new Error("stdin failed"), { code: "EIO" }),
  );
  t.mock.timers.tick(5000);
  t.mock.timers.reset();

  const outcome = await Promise.race([
    exited,
    new Promise((done) => setTimeout(() => done("still running"), 3000)),
  ]);
  assert.equal(outcome, "SIGKILL");
});
