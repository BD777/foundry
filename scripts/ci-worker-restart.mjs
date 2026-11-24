#!/usr/bin/env node
// C19 in CI: a Worker killed mid-input is restarted; the next input continues
// the native session. What the killed input reports depends on the topology,
// and the script asserts whichever one it finds (see scripts/lib/execution-host-topology.mjs):
//   host alive: the execution host outlived the kill; the restarted Worker adopts
//               the run, so the input completes with the fake's DONE, not lost.
//   host dead:  the run died with its host; the input fails as "result was lost"
//               within LOST_WITHIN_MS.
// Linux CI takes the dead path. The Worker starts an execution host only where
// the OS service manager is supported (macOS, or Linux with XDG_RUNTIME_DIR);
// this script's Worker environment sets neither, so the turn runs inside the
// Worker, and the kill ends it. macOS takes the alive path (a launchd service).
// Neither path is a failure.
//
// The real Server binary and the real Worker daemon run on loopback in a
// temporary root this script owns. The Worker runs Claude sessions through the
// Agent SDK, which launches the executable named by FOUNDRY_CLAUDE_BIN, the
// same override the live regression uses on a device. That executable is
// scripts/fixtures/fake-claude-code.cjs: the model is faked, everything else
// on the path is real. The script kills only the Worker it started (after the
// daemon lock names it) and never touches another process.
//
//   node scripts/ci-worker-restart.mjs --server-binary <foundry-server> [--worker-cli <dist/cli.js>] [--keep]
//
// Case and environment notes: docs/live-regression.md (C19).

import { removeSkillSnapshotTree } from "../packages/worker/dist/skills/skill-snapshot-permissions.js";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { parseArgs } from "node:util";
import {
  processAlive,
  executionHosts,
  stopExecutionHosts,
} from "./lib/execution-host-topology.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fakeClaudeSource = join(repo, "scripts/fixtures/fake-claude-code.cjs");
const OWNER = "ci-recovery-owner";
const PROFILE = "claude_local";
const ACTIVE = new Set(["queued", "running", "blocked"]);
const SETTLE_MS = 120_000;
// A dead host's input is marked lost within this long after the kill.
const LOST_WITHIN_MS = 60_000;
// Time for a killed host to exit before its state is read.
const HOST_SETTLE_MS = 2000;

const { values } = parseArgs({
  options: {
    "server-binary": { type: "string" },
    "worker-cli": { type: "string" },
    keep: { type: "boolean" },
  },
});
const serverBinary = resolve(values["server-binary"] ?? "");
const workerCLI = resolve(
  values["worker-cli"] ?? join(repo, "packages/worker/dist/cli.js"),
);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function check(condition, message) {
  if (!condition) throw new Error(message);
}

/** Reads until matches(value) holds, or fails with the last value seen. */
async function until(read, matches, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (matches(value)) return value;
    if (Date.now() > deadline)
      throw new Error(
        `${what} within ${timeoutMs}ms; last value ${JSON.stringify(value)?.slice(0, 300)}`,
      );
    await sleep(1000);
  }
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

/** The pid the Worker holds in its state root's daemon lock, if any. */
function readLockPid(stateRoot) {
  try {
    return Number(readFileSync(join(stateRoot, "daemon.lock"), "utf8").trim());
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Processes started by pid, recursively (pgrep exits 1 when there are none). */
function descendants(pid) {
  let listed;
  try {
    listed = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
  return listed
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .flatMap((child) => [child, ...descendants(child)]);
}

/** Kills a process this script started, with everything it started. */
function killTree(pid) {
  for (const victim of [...descendants(pid), pid]) {
    try {
      process.kill(victim, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

/** One isolated stack: Server, Worker, and the files they keep. */
class Stack {
  constructor() {
    this.root = mkdtempSync(join(tmpdir(), "foundry-ci-recovery-"));
    this.home = join(this.root, "home");
    this.state = join(this.root, "state");
    this.workspace = join(this.root, "workspace");
    this.logs = join(this.root, "logs");
    this.database = join(this.root, "data", "foundry.db");
    this.claudeBin = join(this.root, "bin", "claude");
    this.password = randomBytes(18).toString("base64url");
    this.server = undefined;
    this.worker = undefined;
    this.credential = undefined;
    this.cookie = undefined;
    this.deviceId = undefined;
  }

  async init() {
    this.port = await freePort();
    this.base = `http://127.0.0.1:${this.port}`;
    for (const directory of [
      this.home,
      this.state,
      this.workspace,
      this.logs,
      join(this.root, "data"),
      join(this.root, "bin"),
    ])
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    copyFileSync(fakeClaudeSource, this.claudeBin);
    chmodSync(this.claudeBin, 0o755);
  }

  serverEnv() {
    return {
      PATH: process.env.PATH,
      HOME: this.home,
      PORT: String(this.port),
      FOUNDRY_HOST: "127.0.0.1",
      FOUNDRY_DB_PATH: this.database,
      FOUNDRY_DEMO_SEED: "0",
      FOUNDRY_WEB_ORIGIN: this.base,
      FOUNDRY_INTEGRATIONS: "off",
    };
  }

  workerEnv() {
    return {
      PATH: process.env.PATH,
      HOME: this.home,
      FOUNDRY_STATE_ROOT: this.state,
      FOUNDRY_CLAUDE_BIN: this.claudeBin,
    };
  }

  spawnLogged(name, command, args, env) {
    const fd = openSync(join(this.logs, `${name}.log`), "a");
    try {
      return spawn(command, args, {
        cwd: this.root,
        env,
        stdio: ["ignore", fd, fd],
      });
    } finally {
      closeSync(fd);
    }
  }

  serverRunning() {
    return (
      this.server !== undefined &&
      this.server.exitCode === null &&
      this.server.signalCode === null
    );
  }

  workerRunning() {
    return (
      this.worker !== undefined &&
      this.worker.exitCode === null &&
      this.worker.signalCode === null
    );
  }

  async healthy() {
    try {
      return (await fetch(`${this.base}/healthz`)).ok;
    } catch {
      return false;
    }
  }

  async startServer() {
    this.server = this.spawnLogged(
      "server",
      serverBinary,
      [],
      this.serverEnv(),
    );
    await until(
      () => this.healthy(),
      (ok) => ok,
      60_000,
      "the Server did not become healthy",
    );
  }

  async stopServer() {
    const server = this.server;
    const exited = once(server, "exit");
    const escalate = setTimeout(() => server.kill("SIGKILL"), 20_000);
    server.kill("SIGTERM");
    await exited;
    clearTimeout(escalate);
  }

  async send(method, path, body, headers) {
    const response = await fetch(new URL(path, this.base), {
      method,
      headers:
        body === undefined
          ? headers
          : { ...headers, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    if (!response.ok)
      throw new Error(`${method} ${path} -> ${response.status}: ${raw}`);
    return raw ? JSON.parse(raw) : undefined;
  }

  /** A call as this device (the Worker's session API). */
  request(method, path, body) {
    return this.send(method, path, body, {
      "X-Foundry-Device-Credential": this.credential,
    });
  }

  /** A call as the stack's owner, with the session cookie. */
  ownerRequest(method, path, body) {
    return this.send(method, path, body, {
      Cookie: this.cookie,
      Origin: this.base,
    });
  }

  async login() {
    const response = await fetch(`${this.base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: this.base },
      body: JSON.stringify({ username: OWNER, password: this.password }),
    });
    check(response.ok, `owner login failed: ${response.status}`);
    this.cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  }

  /** Owner, pairing, workspace, then the Worker daemon, as on a device. */
  async boot() {
    await this.init();
    await this.startServer();
    execFileSync(
      serverBinary,
      [
        "users",
        "create",
        "--username",
        OWNER,
        "--role",
        "admin",
        "--password-stdin",
      ],
      {
        env: this.serverEnv(),
        input: `${this.password}\n`,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60_000,
      },
    );
    await this.login();
    const token = execFileSync(
      serverBinary,
      ["devices", "pairing-token", "--username", OWNER],
      {
        env: this.serverEnv(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      },
    ).trim();
    execFileSync(
      process.execPath,
      [
        workerCLI,
        "pair",
        "--server",
        this.base,
        "--workspace",
        this.workspace,
        "--token",
        token,
      ],
      {
        env: this.workerEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      },
    );
    this.credential = JSON.parse(
      readFileSync(join(this.state, "daemon-config.json"), "utf8"),
    ).deviceCredential;
    check(this.credential, "pairing wrote no device credential");
    execFileSync(process.execPath, [workerCLI, "init", this.workspace], {
      env: this.workerEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    this.startWorker();
    const [device] = await until(
      () => this.ownerRequest("GET", "/api/devices").catch(() => []),
      (list) => list.length > 0,
      60_000,
      "the paired device is not listed",
    );
    this.deviceId = device.id;
    await this.ownerRequest("PUT", `/api/devices/${this.deviceId}/profiles`, {
      profileIds: [PROFILE],
    });
  }

  startWorker() {
    check(!this.workerRunning(), "the Worker is already running");
    this.worker = this.spawnLogged(
      "worker",
      process.execPath,
      [
        workerCLI,
        "connect",
        "--server",
        this.base,
        "--workspace",
        this.workspace,
      ],
      this.workerEnv(),
    );
  }

  /** Kills the Worker this script started, after checking the lock names it. */
  async killWorker() {
    check(this.workerRunning(), "the Worker is not running");
    const lockPid = readLockPid(this.state);
    check(
      lockPid === this.worker.pid,
      `refusing to kill: daemon.lock names ${lockPid}, not the Worker this script started (${this.worker.pid})`,
    );
    const worker = this.worker;
    const exited = once(worker, "exit");
    killTree(worker.pid);
    await exited;
  }

  /** Until the Worker holds the daemon lock and the profile is healthy here. */
  async waitWorkerOnline() {
    const pid = this.worker.pid;
    await until(
      () => readLockPid(this.state),
      (lock) => lock === pid,
      60_000,
      "the Worker did not take the daemon lock",
    );
    const [workspace] = await until(
      () => this.request("GET", "/api/workspaces").catch(() => []),
      (list) => list.length > 0,
      60_000,
      "no workspace registered",
    );
    await until(
      () => this.ownerRequest("GET", "/api/agent-profiles").catch(() => []),
      (list) =>
        list.some(
          (item) =>
            item.id === PROFILE &&
            item.deviceId === this.deviceId &&
            item.status === "healthy",
        ),
      180_000,
      `profile ${PROFILE} never became healthy on this device`,
    );
    return workspace;
  }

  printLogTails() {
    for (const name of ["server", "worker"]) {
      const path = join(this.logs, `${name}.log`);
      if (!existsSync(path)) continue;
      const tail = readFileSync(path, "utf8").trimEnd().split("\n").slice(-40);
      console.error(
        `--- ${name}.log (last ${tail.length} lines) ---\n${tail.join("\n")}`,
      );
    }
  }

  async teardown(keep) {
    if (this.workerRunning()) {
      const exited = once(this.worker, "exit");
      killTree(this.worker.pid);
      await exited;
    }
    // The host may outlive the Worker (macOS): stop only the one this stack started.
    try {
      console.log(await stopExecutionHosts(this.state, this.home));
    } catch (error) {
      this.leaked = error.message;
      console.error(`✖ execution host: ${error.message}`);
    }
    if (this.serverRunning()) await this.stopServer();
    if (keep) console.log(`kept ${this.root}`);
    else removeSkillSnapshotTree(this.root);
  }
}

function sessionCalls(stack, workspaceId) {
  return {
    start: (prompt) =>
      stack.request("POST", "/api/agent-sessions", {
        workspaceId,
        provider: "claude",
        profileId: PROFILE,
        prompt,
        source: "chat",
      }),
    send: (id, prompt) =>
      stack.request("POST", `/api/agent-sessions/${id}/messages`, { prompt }),
    async settle(id, timeoutMs = SETTLE_MS) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const session = await stack.request("GET", `/api/agent-sessions/${id}`);
        if (!ACTIVE.has(session.status)) return session;
        check(
          Date.now() <= deadline,
          `${id} did not settle within ${timeoutMs}ms`,
        );
        await sleep(3000);
      }
    },
    async running(id) {
      for (let i = 0; i < 60; i++) {
        const session = await stack.request("GET", `/api/agent-sessions/${id}`);
        if (session.status === "running") return session;
        check(
          ACTIVE.has(session.status),
          `${id} settled before it ran: ${session.status}`,
        );
        await sleep(2000);
      }
      throw new Error(`${id} never started running`);
    },
  };
}

/** A Worker killed mid-input: the input fails as lost, the next one resumes. */
async function workerRestart(stack) {
  const workspace = await stack.waitWorkerOnline();
  const live = sessionCalls(stack, workspace.id);
  const session = await live.start(
    "Remember the codeword PEAR-4. Use Bash to run: sleep 90; then reply DONE.",
  );
  await live.running(session.id);
  await sleep(8000);
  const hosts = executionHosts(stack.state);
  const killedAt = Date.now();
  await stack.killWorker();
  await sleep(HOST_SETTLE_MS);
  const hostAlive = hosts.some((host) => processAlive(host.pid));
  const hostName =
    hosts.length > 0
      ? `execution host ${hosts.map((host) => host.pid).join(", ")}`
      : "no execution host (the turn ran inside the Worker)";
  stack.startWorker();
  const settled = await live.settle(session.id);
  const seconds = Math.round((Date.now() - killedAt) / 1000);
  let outcome;
  if (hostAlive) {
    check(
      settled.status === "completed" && /DONE/.test(settled.response ?? ""),
      `${hostName} alive after the kill, so the input should complete with DONE: ${settled.status} ${settled.response ?? settled.error}`,
    );
    outcome = `${hostName} alive after the kill: the input completed with DONE after ${seconds}s`;
  } else {
    check(
      settled.status === "failed" &&
        /result was lost/.test(settled.error ?? ""),
      `${hostName} gone after the kill, so the input should be lost: ${settled.status} ${settled.response ?? settled.error}`,
    );
    check(
      seconds * 1000 <= LOST_WITHIN_MS,
      `the input was lost after ${seconds}s, over ${LOST_WITHIN_MS / 1000}s`,
    );
    outcome = `${hostName} gone after the kill: the input was lost ${seconds}s after the kill`;
  }
  console.log(`path: ${hostAlive ? "alive" : "dead"}; ${outcome}`);
  await live.send(
    session.id,
    "Ignore the interrupted task. Which codeword did I give you? Reply with just it.",
  );
  const resumed = await live.settle(session.id);
  check(
    resumed.response === "PEAR-4",
    `continue after the restart: ${resumed.response ?? resumed.error}`,
  );
  check(
    !(resumed.events ?? []).some((event) =>
      /Restarted runtime/.test(event.label),
    ),
    "the native context was dropped after the restart",
  );
  return `${outcome}; the next message resumed with PEAR-4`;
}

async function main() {
  check(values["server-binary"], "needs --server-binary <foundry-server>");
  check(existsSync(serverBinary), `missing ${serverBinary}`);
  check(existsSync(workerCLI), `missing ${workerCLI}; build the Worker first`);
  const stack = new Stack();
  let failed = false;
  try {
    await stack.boot();
    console.log(`✔ worker-restart: ${await workerRestart(stack)}`);
  } catch (error) {
    failed = true;
    console.error(`✖ worker-restart: ${error.message}`);
    stack.printLogTails();
  } finally {
    await stack.teardown(values.keep);
  }
  if (stack.leaked) failed = true;
  process.exitCode = failed ? 1 : 0;
}

await main();
