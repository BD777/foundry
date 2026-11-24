#!/usr/bin/env node
// Worker and Server recovery cases (C10, C19, C20) on an isolated stack this
// script owns: its own Server and database, its own Worker with HOME, state
// root and workspace, all on loopback. The script starts every process it
// kills or restarts and refuses to kill a Worker unless the daemon lock names
// the process it started, so no other Server or device is ever touched.
//
//   node scripts/live-recovery-regression.mjs [--cases worker-restart,orphan-input,server-down-marker] [--profile <id>] [--keep]
//
// The stack runs one Server-owned Claude profile, by default the dev server's
// Tencent TokenHub profile. Its row and sealed secret are copied read-only
// from the dev database into the stack's fresh database; the secret is opened
// with the dev key file by path. Nothing is printed. Cases and environments:
// docs/live-regression.md (C10, C19, C20).
//
// C19 asserts by topology: when the execution host survives the kill (macOS
// launchd service) the input completes; when it is gone (Linux without
// XDG_RUNTIME_DIR, no host at all) the input is marked lost. See
// scripts/lib/execution-host-topology.mjs.

import { removeSkillSnapshotTree } from "../packages/worker/dist/skills/skill-snapshot-permissions.js";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { parseArgs } from "node:util";
import {
  processAlive,
  executionHosts,
  stopExecutionHosts,
} from "./lib/execution-host-topology.mjs";

const home = homedir();
const OWNER = "live-recovery-owner";
// Tencent TokenHub (Claude), a Server-owned profile bound to sg-chaos.
const DEFAULT_PROFILE = "prof_2c4c55cc-e65e-4c76-bbed-4495af2b7617";

const { values } = parseArgs({
  options: {
    cases: { type: "string" },
    profile: { type: "string" },
    keep: { type: "boolean" },
    "server-binary": { type: "string" },
    "worker-cli": { type: "string" },
    "dev-db": { type: "string" },
    "secret-key": { type: "string" },
  },
});
const profile = values.profile ?? DEFAULT_PROFILE;
const serverBinary = resolve(
  values["server-binary"] ??
    join(home, ".foundry/server/releases/dev023-candidate/foundry-server"),
);
const workerCLI = resolve(
  values["worker-cli"] ??
    join(
      home,
      ".foundry/runtime/current/node_modules/@bd777/foundry-worker/dist/cli.js",
    ),
);
const devDB = resolve(
  values["dev-db"] ?? join(home, ".foundry/server/foundry.db"),
);
const secretKey = resolve(
  values["secret-key"] ?? join(home, ".foundry/server/foundry-secret.key"),
);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const active = new Set(["queued", "running", "blocked"]);
// C19: a gone execution host's input is marked lost within this long after the kill.
const LOST_WITHIN_MS = 60_000;
// Time for a killed execution host to exit before its state is read.
const HOST_SETTLE_MS = 2000;

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

/** MemAvailable in MB, from /proc/meminfo. */
function availableMB() {
  const line = readFileSync("/proc/meminfo", "utf8")
    .split("\n")
    .find((item) => item.startsWith("MemAvailable:"));
  return Math.floor(Number(line.split(/\s+/)[1]) / 1024);
}

/** Waits while the host is short of memory (another eval shares it). */
async function waitForMemory(minMB, timeoutMs = 40 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (availableMB() < minMB) {
    check(Date.now() < deadline, `MemAvailable stayed under ${minMB} MB`);
    console.log(`paused: MemAvailable ${availableMB()} MB < ${minMB} MB`);
    await sleep(30_000);
  }
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

/** The completion marker a Worker wrote for one session, if any. */
function findMarker(directory, sessionId) {
  let names;
  try {
    names = readdirSync(directory, { recursive: true }).map(String);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  for (const name of names.filter(
    (item) => item.endsWith("completion.json") && item.includes(sessionId),
  )) {
    const marker = JSON.parse(readFileSync(join(directory, name), "utf8"));
    if (marker.sessionId === sessionId && marker.status === "completed")
      return marker;
  }
  return undefined;
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

/**
 * Copies the profile's row, its sealed secret and the secret store's metadata
 * from the dev database (opened read-only) into the stack's database. Only
 * columns both schemas have are copied; the owner is the stack's own user.
 */
function seedProfile(stackDB, ownerID) {
  const source = new DatabaseSync(devDB, { readOnly: true });
  const target = new DatabaseSync(stackDB);
  try {
    const columns = (db, table) =>
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name);
    const quote = (name) => `"${name}"`;
    const copy = (table, where = "", params = []) => {
      const shared = columns(target, table).filter((name) =>
        columns(source, table).includes(name),
      );
      const rows = source
        .prepare(`SELECT ${shared.map(quote).join(",")} FROM ${table} ${where}`)
        .all(...params);
      const insert = target.prepare(
        `INSERT OR REPLACE INTO ${table} (${shared.map(quote).join(",")}) VALUES (${shared.map(() => "?").join(",")})`,
      );
      for (const row of rows) insert.run(...shared.map((name) => row[name]));
      return rows.length;
    };
    target.prepare("DELETE FROM secret_store_meta").run();
    check(
      copy("secret_store_meta") > 0,
      "the dev secret store has no metadata",
    );
    check(
      copy("profiles", "WHERE id = ?", [profile]) === 1,
      `the dev database has no profile ${profile}`,
    );
    check(
      copy("secret_records", "WHERE id = ?", [`agent-profile:${profile}`]) ===
        1,
      `the dev database has no sealed secret for ${profile}`,
    );
    target
      .prepare("UPDATE profiles SET owner_user_id = ? WHERE id = ?")
      .run(ownerID, profile);
  } finally {
    source.close();
    target.close();
  }
}

/** Session calls as the device owner, for one Worker of one stack. */
function liveSession({ request, workspace }) {
  const get = (id) => request("GET", `/api/agent-sessions/${id}`);
  return {
    get,
    start: (prompt) =>
      request("POST", "/api/agent-sessions", {
        workspaceId: workspace.id,
        provider: "claude",
        profileId: profile,
        prompt,
        source: "chat",
      }),
    send: (id, prompt) =>
      request("POST", `/api/agent-sessions/${id}/messages`, { prompt }),
    cancel: (id) => request("POST", `/api/agent-sessions/${id}/cancel`),
    async settle(id, timeoutMs = 300_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const session = await get(id);
        if (!active.has(session.status)) return session;
        if (Date.now() > deadline)
          throw new Error(`${id} did not settle within ${timeoutMs}ms`);
        await sleep(3000);
      }
    },
    async running(id) {
      for (let i = 0; i < 60; i++) {
        const session = await get(id);
        if (session.status === "running") return session;
        if (!active.has(session.status))
          throw new Error(`${id} settled before it ran: ${session.status}`);
        await sleep(2000);
      }
      throw new Error(`${id} never started running`);
    },
  };
}

/** One isolated stack: Server, Worker, and the files they keep. */
class Stack {
  constructor({ name, port }) {
    this.name = name;
    this.port = port;
    this.base = `http://127.0.0.1:${port}`;
    this.root = mkdtempSync(join(tmpdir(), `foundry-liso-${name}-`));
    this.home = join(this.root, "home");
    this.state = join(this.root, "state");
    this.workspace = join(this.root, "workspace");
    this.logs = join(this.root, "logs");
    this.database = join(this.root, "data", "foundry.db");
    this.claudeBin = realpathSync(
      execFileSync("which", ["claude"], { encoding: "utf8" }).trim(),
    );
    this.server = undefined;
    this.worker = undefined;
    this.credential = undefined;
    this.cookie = undefined;
    this.password = randomBytes(18).toString("base64url");
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
      // The dev key, referenced where it lives; the seeded secret needs it.
      FOUNDRY_SECRET_KEY_PATH: secretKey,
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
    check(!this.serverRunning(), `${this.name}: the Server is already running`);
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
    check(this.serverRunning(), `${this.name}: the Server is not running`);
    const server = this.server;
    const exited = once(server, "exit");
    const escalate = setTimeout(() => server.kill("SIGKILL"), 20_000);
    server.kill("SIGTERM");
    await exited;
    clearTimeout(escalate);
  }

  async request(method, path, body) {
    const headers = { "X-Foundry-Device-Credential": this.credential };
    return this.send(method, path, body, headers);
  }

  /** A call as the stack's owner, with the session cookie. */
  async ownerRequest(method, path, body) {
    const headers = { Cookie: this.cookie, Origin: this.base };
    return this.send(method, path, body, headers);
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

  /**
   * Creates the owner, seeds the profile into the fresh database, pairs and
   * binds this stack's Worker to it, and starts the Worker.
   */
  async boot() {
    for (const directory of [
      this.home,
      join(this.home, ".claude"),
      this.state,
      this.workspace,
      this.logs,
      join(this.root, "data"),
    ])
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    const credentials = join(this.home, ".claude", ".credentials.json");
    copyFileSync(join(home, ".claude", ".credentials.json"), credentials);
    chmodSync(credentials, 0o600);

    // First start creates the schema and the secret store, with the dev key.
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
    await this.stopServer();
    const ownerRow = new DatabaseSync(this.database).prepare(
      "SELECT id FROM users WHERE username = ?",
    );
    const ownerID = ownerRow.get(OWNER)?.id;
    check(ownerID, "the owner was not created");
    seedProfile(this.database, ownerID);

    await this.startServer();
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
      profileIds: [profile],
    });
    await this.waitWorkerOnline();
  }

  startWorker() {
    check(!this.workerRunning(), `${this.name}: the Worker is already running`);
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

  /** Kills the Worker this stack started, after checking the lock names it. */
  async killWorker() {
    check(this.workerRunning(), `${this.name}: the Worker is not running`);
    const lockPid = readLockPid(this.state);
    check(
      lockPid === this.worker.pid,
      `refusing to kill: daemon.lock names ${lockPid}, not the Worker this stack started (${this.worker.pid})`,
    );
    const worker = this.worker;
    const exited = once(worker, "exit");
    killTree(worker.pid);
    await exited;
  }

  /**
   * Until this stack's Worker holds the daemon lock and the profile reports
   * healthy on this device; returns the workspace.
   */
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
            item.id === profile &&
            item.deviceId === this.deviceId &&
            item.status === "healthy",
        ),
      180_000,
      `profile ${profile} never became healthy on this device`,
    );
    return workspace;
  }

  /** Session calls once the Worker is online. */
  async live() {
    const workspace = await this.waitWorkerOnline();
    return liveSession({
      request: (...args) => this.request(...args),
      workspace,
    });
  }

  /** Waits for the Worker to write the completion marker of one session. */
  async completionMarker(sessionId, timeoutMs) {
    return until(
      () => findMarker(join(this.workspace, ".foundry"), sessionId),
      (marker) => marker !== undefined,
      timeoutMs,
      `no completion marker for ${sessionId}`,
    );
  }

  async teardown(keep) {
    if (this.workerRunning()) {
      const exited = once(this.worker, "exit");
      killTree(this.worker.pid);
      await exited;
    }
    // The execution host may outlive the Worker (macOS): stop the one this stack started.
    try {
      console.log(await stopExecutionHosts(this.state, this.home));
    } catch (error) {
      console.error(`execution host not stopped: ${error.message}`);
    }
    if (this.serverRunning()) await this.stopServer();
    if (keep) console.log(`kept ${this.root}`);
    else removeSkillSnapshotTree(this.root);
  }
}

/**
 * Cancels the orphan once the Worker is back. The Server refuses cancels while
 * the device reconnects (409), so this retries until it accepts one or the
 * input has already settled (the Worker reports it lost on reconnect).
 */
async function cancelOrphan(live, id) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const session = await live.get(id);
    if (!active.has(session.status))
      return `not needed: the orphan had already ${session.status}`;
    try {
      await live.cancel(id);
      return "accepted";
    } catch (error) {
      if (!/reconnecting/.test(error.message) || Date.now() > deadline)
        return `refused (${error.message.slice(0, 160)})`;
    }
    await sleep(1000);
  }
}

const cases = {
  // C19: a Worker killed mid-input. What the input reports after the restart
  // depends on the execution host, which the kill may or may not reach:
  // alive, the restarted Worker adopts the run and the input completes; gone,
  // the input fails as lost within LOST_WITHIN_MS. Either way the next message
  // resumes the native context.
  async "worker-restart"(stack) {
    const live = await stack.live();
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
    const settled = await live.settle(session.id, 120_000);
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
    console.log(`path: ${hostAlive ? "alive" : "gone"}; ${outcome}`);
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
  },

  // C10: a Worker killed while a second input runs. The first input's
  // completion marker must not end the second one; the orphan is canceled
  // while the Worker is down; the input after it keeps the native context.
  async "orphan-input"(stack) {
    const live = await stack.live();
    const first = await live.start(
      "Remember the codeword PEAR-4. Reply with exactly: NOTED",
    );
    const noted = await live.settle(first.id);
    check(
      noted.status === "completed" && noted.response === "NOTED",
      `first input: ${noted.status} ${noted.response ?? noted.error}`,
    );
    await live.send(
      first.id,
      "Use Bash to run: sleep 90; then reply DONE-TWO.",
    );
    await live.running(first.id);
    await sleep(8000);
    await stack.killWorker();
    stack.startWorker();
    const cancel = await cancelOrphan(live, first.id);
    const orphan = await live.settle(first.id, 120_000);
    check(
      orphan.status !== "completed" && orphan.response !== "NOTED",
      `the first input's marker ended the second: ${orphan.status} ${orphan.response}`,
    );
    await live.send(
      first.id,
      "Ignore the interrupted and canceled tasks. Which codeword did I give you? Reply with just it.",
    );
    const resumed = await live.settle(first.id);
    check(
      resumed.status === "completed" && resumed.response === "PEAR-4",
      `the input after the orphan: ${resumed.status} ${resumed.response ?? resumed.error}`,
    );
    return `second input ended ${orphan.status} (cancel ${cancel}), not NOTED; the next input answered PEAR-4`;
  },

  // C20: the Server stops while an input runs. The Worker finishes it and
  // writes the completion marker; then the Worker is killed. After both come
  // back, the input completes with the marker's answer.
  async "server-down-marker"(stack) {
    const live = await stack.live();
    const session = await live.start(
      "Use Bash to run: sleep 25; then reply DONE-C20 and nothing else.",
    );
    await live.running(session.id);
    await sleep(6000);
    await stack.stopServer();
    const marker = await stack.completionMarker(session.id, 240_000);
    check(
      !(await stack.healthy()),
      "the Server came back before the Worker wrote its marker",
    );
    check(
      /DONE-C20/.test(marker.response ?? ""),
      `marker answer: ${marker.response}`,
    );
    await stack.killWorker();
    await stack.startServer();
    stack.startWorker();
    const restarted = await stack.live();
    const done = await restarted.settle(session.id, 120_000);
    check(
      done.status === "completed" && /DONE-C20/.test(done.response ?? ""),
      `after both restarts: ${done.status} ${done.response ?? done.error}`,
    );
    return `the Worker wrote the marker with the Server down; after both restarts the input completed with DONE-C20`;
  },
};

const selected = values.cases
  ? values.cases.split(",").map((name) => name.trim())
  : Object.keys(cases);
for (const name of selected)
  if (!cases[name]) {
    console.error(
      `unknown case ${name}; cases: ${Object.keys(cases).join(", ")}`,
    );
    process.exit(2);
  }
for (const path of [serverBinary, workerCLI, devDB, secretKey])
  check(existsSync(path), `missing ${path}`);

const running = new Set();
let failed = 0;

async function shutdown() {
  for (const stack of running) await stack.teardown(false);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await shutdown();
    process.exit(130);
  });

console.log(
  `isolated stacks run profile ${profile}; cases: ${selected.join(", ")}`,
);
for (const name of selected) {
  await waitForMemory(800);
  const started = Date.now();
  const stack = new Stack({ name, port: await freePort() });
  running.add(stack);
  try {
    await stack.boot();
    const evidence = await cases[name](stack);
    console.log(
      `✔ ${name} (${Math.round((Date.now() - started) / 1000)}s): ${evidence}`,
    );
  } catch (error) {
    failed++;
    console.log(
      `✖ ${name} (${Math.round((Date.now() - started) / 1000)}s): ${error instanceof Error ? error.message : error}`,
    );
    console.log(`  logs: ${stack.logs}`);
  } finally {
    await stack.teardown(values.keep);
    running.delete(stack);
  }
}
process.exit(failed ? 1 : 0);
