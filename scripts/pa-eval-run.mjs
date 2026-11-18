#!/usr/bin/env node
// Runs the Personal Agent eval (docs/personal-agent.md §13) on a hermetic
// stack (--stack-dir: a prebuilt server binary on a fresh database seeded with
// the eval set's fixture projects and one server model profile,
// FOUNDRY_INTEGRATIONS=off, dead proxy), never on a live one. Nothing is
// built; the Worker is the one installed on this computer.
//
//   e2e (--e2e)        a real model: a sample of cases, each a fresh assistant
//                      session in the Personal Agent workspace (the person's
//                      native Claude/Codex login through a Foundry worker).
//                      Routing is the assistant's own judgement from
//                      .foundry/project-index.md, .foundry/projects/ and its
//                      notes; the score is the workspace it dispatched to
//                      against the case's gold project.
//                      Scored from its tool calls and reply: routing accuracy,
//                      wrong dispatches when it went ahead, asking on ambiguous
//                      requests, needless questions, "should create" precision
//                      and recall, wrong creations, banned words, latency and
//                      cost. Helpers it starts are cancelled at once, and
//                      projects it created and what it remembered are undone
//                      after each case. The copy's projects sit on the
//                      person's computers, offline here: a refused dispatch,
//                      or a reply naming exactly one such project in quotes,
//                      is its decision. The worker runs in bubblewrap (home
//                      read-only, keys hidden): the assistant is a real agent
//                      on this computer. --judge
//                      adds one read-only Foundry session that rates whether
//                      each reply is plain, human language.
//   --scenario a1a2    acceptance A1 and A2 with a real model, for a fresh
//                      account whose only project is the assistant's own: "make
//                      a small web page for family spending" must create a
//                      project, start work there, and report a link once the
//                      work is done (helpers run, up to --scenario-timeout-s);
//                      "add an Excel export" in the same conversation must land
//                      in that project without creating another.
//   --scenario plans   the person's real message of 2026-10-15 (plans for
//                      after work and the afternoon, a draft to finish, a
//                      talk already had), as --user on the copy with the
//                      assistant moved to the sandboxed worker: their list
//                      must get the four things (the talk as done), the reply
//                      must not offer to book a meeting or contact anyone and
//                      must not name a program, a technical project or
//                      computer name; then "我一般 7 点下班，到时提醒我" must
//                      set reminders at 19:00 on the after-work items.
//
// Setup, all through the stack's HTTP API, as the stack's synthetic user
// (password in DIR/data/eval-user.password; never the person's account). A
// worker is paired to the person with its own state root and HOME under the
// instance (e2e: CLAUDE_CONFIG_DIR / CODEX_HOME point at the real logins, or
// --worker-home real), the assistant is set up on it. Each e2e case then
// runs a real assistant turn;
// its dispatched workspace is the routing answer.
//
// usage: node scripts/pa-eval-run.mjs --stack-dir DIR [--e2e] [--sample N]
//          [--only id,id] [--judge] [--instance NAME] [--reuse] [--keep]
//          [--profile ID[,model[,effort]]] [--max-cost-usd N]
//          [--user USERNAME] [--provider claude|codex] [--model M]
//          [--worker-home scratch|real] [--case-timeout-s N] [--eval DIR]
//          [--out FILE] [--scenario a1a2|plans] [--scenario-timeout-s N]
// Exit: 0 every gate passed, 1 a gate failed, 2 the run itself failed.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  classifyOutcome,
  DISPATCH_TOOLS,
  cardAsksIn,
  parseJudgeAnswer,
  parseToolEvent,
  questionsIn,
} from "./pa-eval-score.mjs";

const root = resolve(import.meta.dirname, "..");

// The header comment above is the usage.
const usage = () =>
  readFileSync(import.meta.filename, "utf8")
    .split("\n")
    .slice(1)
    .filter((_, i, lines) =>
      lines.slice(0, i + 1).every((l) => l.startsWith("//")),
    )
    .map((l) => l.replace(/^\/\/ ?/, ""))
    .join("\n");
const liveDB = resolve(homedir(), ".foundry/server/foundry.db");

// §13 gates.
const gates = {
  clearTop1: 0.9,
  wrongDispatch: 0.03,
  askOnAmbiguous: 0.8,
  newPrecision: 0.85,
  newRecall: 0.85,
  bannedTerms: 0,
  questionsPerRequest: 0.2,
};

// §12: words the assistant does not use with the person unless they did.
const bannedTerms = [
  ["workspace", /\bworkspaces?\b/i, /workspace|工作区/i],
  ["device", /\bdevices?\b/i, /device|设备/i],
  ["session", /\bsessions?\b/i, /session|会话/i],
  ["repo", /\brepo(sitor(y|ies))?s?\b/i, /repo|仓库/i],
  ["branch", /\bbranch(es)?\b/i, /branch|分支/i],
  ["commit", /\bcommits?\b/i, /commit|提交/i],
  ["Issue", /\bIssues?\b/, /issue/i],
  ["profile", /\bprofiles?\b/i, /profile/i],
  ["runtime", /\bruntimes?\b/i, /runtime/i],
  ["model", /\bmodels?\b/i, /model|模型/i],
  ["MCP", /\bMCP\b/, /mcp/i],
  ["token", /\btokens?\b/i, /token|令牌/i],
  ["agent", /\bagents?\b/i, /agent|智能体/i],
  ["prompt", /\bprompts?\b/i, /prompt|提示词/i],
  ["directory", /\bdirector(y|ies)\b/i, /directory|目录/i],
  ["path", /\bpaths?\b/i, /path|路径/i],
  ["Claude", /\bclaude\b/i, /claude/i],
  ["Codex", /\bcodex\b/i, /codex/i],
  ["工作区", /工作区/, /workspace|工作区/i],
  ["设备", /设备/, /device|设备/i],
  ["会话", /会话/, /session|会话/i],
  ["仓库", /仓库/, /repo|仓库/i],
  ["分支", /分支/, /branch|分支/i],
  ["令牌", /令牌/, /token|令牌/i],
  ["智能体", /智能体/, /agent|智能体/i],
  ["提示词", /提示词/, /prompt|提示词/i],
  ["目录", /目录/, /directory|目录|文件夹/i],
  ["路径", /路径/, /path|路径/i],
];

const specialTargets = new Set(["new", "answer", "ask"]);

// --- arguments ---------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    e2e: false,
    sample: 24,
    only: [],
    judge: false,
    instance: "pa-eval",
    reuse: false,
    keep: false,
    user: "pa1-eval",
    stackDir: process.env.PA_EVAL_STACK_DIR || "",
    maxCostUsd: 20,
    provider: "claude",
    model: "",
    workerHome: "",
    caseTimeoutS: 360,
    evalDir: resolve(homedir(), ".foundry/pa-eval/set"),
    out: "",
    scenario: "",
    scenarioTimeoutS: 1800,
  };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--e2e":
        args.e2e = true;
        break;
      case "--no-routing":
        // Kept for older invocations; routing accuracy now comes from --e2e.
        break;
      case "--sample":
        args.sample = Number(value());
        break;
      case "--only":
        args.only = value().split(",").filter(Boolean);
        break;
      case "--judge":
        args.judge = true;
        break;
      case "--instance":
        args.instance = value();
        break;
      case "--max-cost-usd":
        args.maxCostUsd = Number(value());
        break;
      case "--stack-dir":
        args.stackDir = value();
        break;
      case "--profile": {
        const [id, model, effort] = value().split(",");
        Object.assign(runProfile, {
          id,
          model: model || "",
          effort: effort || runProfile.effort,
        });
        break;
      }
      case "--reuse":
        args.reuse = true;
        break;
      case "--keep":
        args.keep = true;
        break;
      case "--user":
        args.user = value();
        break;
      case "--provider":
        args.provider = value();
        break;
      case "--model":
        args.model = value();
        break;
      case "--worker-home":
        args.workerHome = value();
        break;
      case "--case-timeout-s":
        args.caseTimeoutS = Number(value());
        break;
      case "--eval":
        args.evalDir = resolve(value());
        break;
      case "--out":
        args.out = resolve(value());
        break;
      case "--scenario":
        args.scenario = value();
        break;
      case "--scenario-timeout-s":
        args.scenarioTimeoutS = Number(value());
        break;
      case "-h":
      case "--help":
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument ${flag}`);
    }
  }
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(args.instance))
    throw new Error("--instance must match [a-z0-9][a-z0-9-]*");
  if (!["claude", "codex"].includes(args.provider))
    throw new Error("--provider is claude or codex");
  args.workerHome ||= "scratch";
  if (!["scratch", "real"].includes(args.workerHome))
    throw new Error("--worker-home is scratch or real");
  if (args.scenario && !["a1a2", "plans"].includes(args.scenario))
    throw new Error("--scenario is a1a2 or plans");
  if (!args.e2e && !args.scenario)
    throw new Error(
      "nothing to run: routing accuracy needs --e2e (or use --scenario)",
    );
  return args;
}

const log = (...parts) => console.error("pa-eval:", ...parts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => createHash("sha1").update(s).digest("hex");

class SetupError extends Error {}

// --- eval set ----------------------------------------------------------------

function loadEvalSet(dir) {
  const casesPath = resolve(dir, "cases.jsonl");
  const indexPath = resolve(dir, "index.json");
  if (!existsSync(casesPath) || !existsSync(indexPath))
    throw new SetupError(
      `no eval set in ${dir} (node scripts/pa-eval-build.mjs)`,
    );
  const cases = readFileSync(casesPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const names = new Map(index.projects.map((p) => [p.workspaceId, p.ref]));
  return { cases, index, names };
}

// What counts as right for a case: its target and the acceptable ones.
// De-identification took links, pasted text and images out of some
// requests; asking the person for what is missing is then right too.
function accepted(c) {
  const right = new Set([c.gold.target, ...(c.gold.acceptable || [])]);
  if (redactedPayload.test(c.request)) right.add("ask");
  return right;
}

const redactedPayload =
  /<(内部链接|链接|飞书链接|需求单链接|[^<>\s]+ 链接)>|<git 仓库[^>]*>|（粘贴的内容）|\[图片\]/;

function goldKind(c) {
  return specialTargets.has(c.gold.target) ? c.gold.target : "project";
}

// --- scratch stack -------------------------------------------------------------

// A prepared hermetic stack directory (--stack-dir): bin/foundry-server (a
// prebuilt binary), data/foundry.db (fresh, seeded) and
// data/eval-user.password (the synthetic user's). Nothing is built and no
// database is copied; the server runs on a free port and stops at the end.
class Stack {
  constructor(name, dir) {
    if (!dir) throw new SetupError("--stack-dir is required");
    this.name = name;
    this.dir = resolve(dir);
    this.evalDir = resolve(this.dir, "pa-eval");
    this.bin = resolve(this.dir, "bin/foundry-server");
    this.dbPath = resolve(this.dir, "data/foundry.db");
    this.pidFile = resolve(this.dir, "server.pid");
  }

  load() {
    if (!existsSync(this.bin) || !existsSync(this.dbPath))
      throw new SetupError(`no server binary or database in ${this.dir}`);
    if (resolve(this.dbPath) === resolve(liveDB))
      throw new SetupError("refusing to use the live database");
    mkdirSync(this.evalDir, { recursive: true, mode: 0o700 });
  }

  password() {
    return readFileSync(
      resolve(this.dir, "data/eval-user.password"),
      "utf8",
    ).trim();
  }

  async up() {
    this.load();
    this.down();
    const port = await freePort();
    this.url = `http://127.0.0.1:${port}`;
    log(`starting ${this.bin} on ${this.url}`);
    mkdirSync(resolve(this.dir, "logs"), { recursive: true });
    const logFile = openSync(resolve(this.dir, "logs/server.log"), "a");
    const child = spawn(this.bin, [], {
      env: {
        ...this.serverEnv(),
        FOUNDRY_HOST: "127.0.0.1",
        PORT: String(port),
        FOUNDRY_WEB_ORIGIN: this.url,
      },
      stdio: ["ignore", logFile, logFile],
      detached: true,
    });
    child.unref();
    writeFileSync(this.pidFile, String(child.pid));
    for (let i = 0; i < 120; i++) {
      const ok = await fetch(`${this.url}/healthz`)
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) return;
      await sleep(500);
    }
    throw new SetupError(
      `the server did not start (${this.dir}/logs/server.log)`,
    );
  }

  down() {
    const pid = existsSync(this.pidFile)
      ? Number(readFileSync(this.pidFile, "utf8"))
      : 0;
    if (!pid || !isOurs(pid, this.bin)) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
    for (let i = 0; i < 40 && isOurs(pid, this.bin); i++)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    if (isOurs(pid, this.bin)) process.kill(pid, "SIGKILL");
  }

  // The environment every run of this instance's server binary gets, as
  // scratch-stack.sh's server_env: its own DB copy, never the live one.
  serverEnv() {
    const dead = "http://127.0.0.1:9";
    return {
      ...cleanEnv(process.env),
      HTTP_PROXY: dead,
      HTTPS_PROXY: dead,
      ALL_PROXY: dead,
      http_proxy: dead,
      https_proxy: dead,
      all_proxy: dead,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      FOUNDRY_DB_PATH: this.dbPath,
      // The key the seeded profile's secret is wrapped with, referenced
      // read-only where it lives, never copied.
      FOUNDRY_SECRET_KEY_PATH:
        process.env.PA_EVAL_SECRET_KEY_PATH ||
        resolve(this.dir, "data/foundry-secret.key"),
      FOUNDRY_STATE_ROOT: resolve(this.dir, "state"),
      FOUNDRY_INTEGRATIONS: "off",
    };
  }

  setPassword(username, password) {
    const result = spawnSync(
      this.bin,
      ["users", "reset-password", "--username", username, "--password-stdin"],
      {
        input: password,
        encoding: "utf8",
        env: this.serverEnv(),
      },
    );
    if (result.status !== 0)
      throw new SetupError(
        `could not set ${username}'s password on the copy: ${result.stderr}`,
      );
  }

  createUser(username, password) {
    const env = this.serverEnv();
    const bin = this.bin;
    const created = spawnSync(
      bin,
      [
        "users",
        "create",
        "--username",
        username,
        "--role",
        "member",
        "--password-stdin",
      ],
      { input: password, encoding: "utf8", env },
    );
    if (created.status !== 0) this.setPassword(username, password);
  }
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

// A Foundry session exports FOUNDRY_* naming its own (live) stack; none of it
// may reach the scratch stack (scratch-stack.sh drops them the same way).
function cleanEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([k]) => !k.startsWith("FOUNDRY_") && k !== "CLAUDE_CODE_USE_FOUNDRY",
    ),
  );
}

// --- HTTP ----------------------------------------------------------------------

class Client {
  constructor(base) {
    this.base = base;
    this.cookie = "";
  }

  // A restarted worker shows as connected a moment before its socket is: a
  // 409 "not connected" is retried for up to a minute.
  async request(method, path, options = {}) {
    const { expect = [200, 201, 202, 204], raw = false } = options;
    let result;
    for (let attempt = 0; ; attempt++) {
      result = await this.send(method, path, options);
      const notConnected =
        result.status === 409 &&
        /not connected/i.test(JSON.stringify(result.data));
      if (!notConnected || attempt >= 30) break;
      await sleep(2000);
    }
    if (raw) return result;
    if (!expect.includes(result.status)) {
      const data =
        typeof result.data === "string"
          ? result.data
          : JSON.stringify(result.data);
      const error = new Error(
        `${method} ${path}: ${result.status} ${data}`.slice(0, 600),
      );
      error.status = result.status;
      throw error;
    }
    return result.data;
  }

  async send(method, path, { body, bearer, device } = {}) {
    const headers = { Origin: this.base };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET")
      headers["Idempotency-Key"] = randomBytes(12).toString("hex");
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    else if (device) headers["X-Foundry-Device-Credential"] = device;
    else if (this.cookie) headers.Cookie = this.cookie;
    const response = await fetch(this.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.getSetCookie?.() || [];
    if (setCookie.length && !bearer && !device)
      this.cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    return { status: response.status, data };
  }

  get(path, options) {
    return this.request("GET", path, options);
  }

  post(path, body, options = {}) {
    return this.request("POST", path, { ...options, body });
  }

  async mcp(token, name, args) {
    const data = await this.post(
      "/api/mcp",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      },
      { bearer: token },
    );
    if (data?.error)
      throw Object.assign(new Error(`${name}: ${data.error.message}`), {
        rpc: data.error,
      });
    const result = data?.result || {};
    const text = (result.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (result.isError)
      throw Object.assign(new Error(`${name}: ${text}`), { toolError: text });
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

const notImplemented = (error) =>
  error?.status === 404 ||
  error?.status === 405 ||
  error?.status === 501 ||
  /not available yet/.test(error?.message || "");

// --- worker --------------------------------------------------------------------

class Worker {
  constructor(stack, workerHome, name = "worker", provider = "claude") {
    this.stack = stack;
    this.name = name;
    this.provider = provider;
    this.stateRoot = resolve(stack.evalDir, `${name}-state`);
    this.home =
      workerHome === "real"
        ? homedir()
        : resolve(stack.evalDir, `${name}-home`);
    // A seeded server profile is the model: the person's own logins (and
    // their CLAUDE.md, memory and transcripts) stay out of the run.
    this.realLogins = workerHome === "scratch" && !runProfile.id;
    // The Worker installed on this computer (nothing is built here).
    this.cli = realpathSync(
      process.env.PA_EVAL_WORKER_CLI ||
        resolve(
          homedir(),
          ".foundry/runtime/current/node_modules/@bd777/foundry-worker/dist/cli.js",
        ),
    );
    this.pidFile = resolve(stack.evalDir, `${name}.pid`);
    this.logPath = resolve(stack.evalDir, `${name}.log`);
  }

  // Only what the harness sets reaches the worker: the caller's session
  // (a Foundry or Claude Code session) exports CLAUDE_*, ANTHROPIC_MODEL,
  // CLAUDE_EFFORT, proxies and a TMPDIR under its own run folder, any of
  // which would change the model, the route or the sandbox. A login's folder
  // is set below, from the harness's own choice.
  env({ logins }) {
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) =>
          ["PATH", "USER", "LOGNAME", "LANG", "TZ"].includes(k) ||
          k.startsWith("LC_"),
      ),
    );
    const env = {
      ...inherited,
      FOUNDRY_STATE_ROOT: this.stateRoot,
      FOUNDRY_STACK: `scratch-${this.stack.name}`,
      // Each case is one turn: an idle runtime kept for the default 15
      // minutes is only memory (a few hundred MB each, several per case).
      FOUNDRY_ACTIVE_RUNTIME_TTL_MS: "15000",
      HOME: this.home,
    };
    // Only the run's own provider's login: another one on the device would
    // be the person's account serving the assistant's upkeep.
    if (logins && this.realLogins && this.provider === "claude")
      env.CLAUDE_CONFIG_DIR =
        process.env.CLAUDE_CONFIG_DIR || resolve(homedir(), ".claude");
    if (logins && this.realLogins && this.provider === "codex")
      env.CODEX_HOME = process.env.CODEX_HOME || resolve(homedir(), ".codex");
    return env;
  }

  credential() {
    const path = resolve(this.stateRoot, "daemon-config.json");
    const credential = existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8")).deviceCredential
      : "";
    if (!credential) throw new SetupError(`no device credential in ${path}`);
    return credential;
  }

  async pair(client) {
    if (!existsSync(this.cli))
      throw new SetupError(`no installed worker at ${this.cli}`);
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    mkdirSync(this.stateRoot, { recursive: true, mode: 0o700 });
    const before = new Set((await client.get("/api/devices")).map((d) => d.id));
    const { token } = await client.post("/api/devices/pairing-tokens");
    const result = spawnSync(
      "node",
      [
        this.cli,
        "setup",
        "--server",
        this.stack.url,
        "--token",
        token,
        "--no-service",
      ],
      { encoding: "utf8", env: this.env({ logins: false }) },
    );
    if (result.status !== 0)
      throw new SetupError(
        `worker setup failed: ${result.stderr || result.stdout}`,
      );
    const after = await client.get("/api/devices");
    // This server lists a device from its first connection on; setup wrote
    // the id it was given.
    const deviceFile = resolve(this.stateRoot, "device.json");
    const device =
      after.find((d) => !before.has(d.id)) ||
      (existsSync(deviceFile) && JSON.parse(readFileSync(deviceFile, "utf8")));
    if (!device?.id)
      throw new SetupError("the paired worker did not appear as a device");
    return device.id;
  }

  async start({ logins }) {
    await this.stop();
    this.logins = logins;
    const logFile = openSync(this.logPath, "a");
    const command = ["node", this.cli, "connect"];
    const [file, ...argv] = logins
      ? [
          ...sandbox(this.provider, this.cli, this.realLogins, [
            this.stack.evalDir,
          ]),
          ...command,
        ]
      : command;
    const child = spawn(file, argv, {
      env: this.env({ logins }),
      stdio: ["ignore", logFile, logFile],
      detached: true,
    });
    child.unref();
    writeFileSync(this.pidFile, String(child.pid));
    this.pid = child.pid;
  }

  async stop() {
    const pid =
      this.pid ||
      (existsSync(this.pidFile)
        ? Number(readFileSync(this.pidFile, "utf8"))
        : 0);
    if (!pid || !isOurs(pid, this.cli)) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
    for (let i = 0; i < 40 && isOurs(pid, this.cli); i++) await sleep(250);
    if (isOurs(pid, this.cli)) process.kill(pid, "SIGKILL");
    this.pid = 0;
  }

  async waitConnected(client, deviceId, connected = true, timeoutMs = 60_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const device = (await client.get("/api/devices")).find(
        (d) => d.id === deviceId,
      );
      if (device && (device.status === "connected") === connected) return;
      await sleep(1000);
    }
    throw new SetupError(
      `the worker did not ${connected ? "connect" : "disconnect"} within ${timeoutMs / 1000}s (log: ${this.logPath})`,
    );
  }
}

// With a model, the assistant is a full agent on this computer, which is
// the person's own, not a fixture: real requests ("update feishu-cli and
// install its skills") would really run. The worker and everything it starts
// see the whole host read-only (--ro-bind / /), with a private /dev, /proc and
// /tmp and their own process view (--unshare-pid). They can write only to
// `writable` (the run's own folder: the Worker's state, home and fixture
// workspaces) and, with a real login, to that login's config folder. Keys and
// tokens under the person's home are hidden (tmpfs). `--sandbox-check` proves
// this from inside. Setuid programs (sudo) do not work inside.
function sandbox(provider, cli, realLogins = true, writable = []) {
  const bwrap = ["/usr/bin/bwrap", "/bin/bwrap"].find((p) => existsSync(p));
  if (!bwrap)
    throw new SetupError(
      "bubblewrap (bwrap) is needed to run the assistant with a model here without letting it change this computer",
    );
  const home = homedir();
  const at = (...parts) => resolve(home, ...parts);
  const args = [
    bwrap,
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
  ];
  const loginDirs = realLogins
    ? [
        process.env.CLAUDE_CONFIG_DIR || at(".claude"),
        ...(provider === "codex"
          ? [process.env.CODEX_HOME || at(".codex")]
          : []),
      ]
    : [];
  // After the tmpfs /tmp, so a run root under /tmp stays visible.
  for (const dir of loginDirs)
    if (existsSync(dir)) args.push("--bind", dir, dir);
  // A login's config folder is writable as a whole; the files the person
  // owns in it come back read-only. Without a login the folder is hidden.
  if (realLogins) {
    const claude = process.env.CLAUDE_CONFIG_DIR || at(".claude");
    for (const name of [
      "CLAUDE.md",
      "settings.json",
      "settings.local.json",
      "skills",
      "rules",
      "notes",
      "commands",
      "hooks",
      "agents",
      "plugins",
    ]) {
      const path = resolve(claude, name);
      if (existsSync(path)) args.push("--ro-bind", path, path);
    }
  }
  for (const secret of [
    ...(realLogins ? [] : [".claude", ".codex"]),
    ".ssh",
    ".foundry",
    ".feishu-cli",
    ".lark-cli",
    ".config/gh",
    ".docker",
    ".aws",
    ".kube",
    ".gnupg",
  ]) {
    const path = at(secret);
    if (existsSync(path)) args.push("--tmpfs", path);
  }
  // The installed Worker lives under the hidden ~/.foundry: its runtime
  // folder comes back read-only, nothing else of it.
  const runtime = resolve(cli, "../../../../..");
  if (runtime.startsWith(at(".foundry") + "/"))
    args.push("--ro-bind", runtime, runtime);
  // Last, so the run folder stays writable where a hidden folder (a
  // tmpfs over ~/.foundry) covers its real path.
  for (const dir of writable)
    if (existsSync(dir)) args.push("--bind", dir, dir);
  args.push("--unshare-pid", "--proc", "/proc", "--die-with-parent", "--");
  return args;
}

// --sandbox-check: the sandbox proven from inside. A write under the run's own
// folder succeeds; writes to /var/tmp, to the home directory and to /etc fail;
// the process list is the sandbox's own (--unshare-pid). Exit 0 when all hold.
function sandboxCheck() {
  const root = mkdtempSync(
    resolve(process.env.TMPDIR || tmpdir(), "pa-eval-sandbox-"),
  );
  const probes = [
    "/var/tmp/pa-eval-sandbox-probe",
    resolve(homedir(), "pa-eval-sandbox-probe"),
    "/etc/pa-eval-sandbox-probe",
  ];
  const script = [
    `echo x > '${resolve(root, "inside-probe")}' && echo INSIDE_WRITE_OK`,
    ...probes.map(
      (p) => `(echo x > '${p}') 2>/dev/null && echo 'OUTSIDE_WRITE ${p}'`,
    ),
    'echo "PROCESSES $(ls /proc | grep -c "^[0-9]")"',
  ].join("; ");
  try {
    const [file, ...argv] = [
      ...sandbox("claude", "/nonexistent/cli.js", false, [root]),
      "sh",
      "-c",
      script,
    ];
    const result = spawnSync(file, argv, { encoding: "utf8", timeout: 30000 });
    const out = result.stdout || "";
    const processes = Number(/PROCESSES (\d+)/.exec(out)?.[1] ?? NaN);
    const checks = [
      ["write inside the run folder succeeds", out.includes("INSIDE_WRITE_OK")],
      ["no write outside the run folder", !out.includes("OUTSIDE_WRITE")],
      ["own process view (--unshare-pid)", processes > 0 && processes < 30],
    ];
    for (const [name, pass] of checks)
      console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
    if (!checks.every(([, pass]) => pass)) console.log(out, result.stderr);
    return checks.every(([, pass]) => pass) ? 0 : 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function isOurs(pid, needle) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(needle);
  } catch {
    return false;
  }
}

// --- the assistant ---------------------------------------------------------------

async function ensureAssistant(client, deviceId) {
  let overview;
  try {
    overview = await client.get("/api/personal-agent");
  } catch (error) {
    if (notImplemented(error))
      throw new SetupError(
        "this server has no Personal Agent yet (GET /api/personal-agent): WP-S1 is not in this build",
      );
    throw error;
  }
  if (!overview?.agent) {
    log(`setting up the assistant on ${deviceId}`);
    await client.post("/api/personal-agent", { deviceId });
    const until = Date.now() + 120_000;
    while (Date.now() < until && !overview?.agent?.workspaceId) {
      await sleep(1500);
      overview = await client.get("/api/personal-agent");
    }
    if (!overview?.agent?.workspaceId)
      throw new SetupError("the assistant was not set up within 120s");
  }
  const agent = overview.agent;
  return agent;
}

async function startAssistantSession(client, agent, provider, model, prompt) {
  let agents = [];
  try {
    agents = await client.get(
      `/api/agents?workspaceId=${encodeURIComponent(agent.workspaceId)}`,
    );
  } catch {
    agents = [];
  }
  const pick =
    agents.find(
      (a) => a.provider === provider && a.deviceId === agent.homeDeviceId,
    ) || agents.find((a) => a.provider === provider);
  const body = {
    workspaceId: agent.workspaceId,
    prompt,
    source: "chat",
    // A seeded server profile has no per-device agent: the session names it.
    ...(runProfile.id
      ? { provider: runProfile.runtime, profileId: runProfile.id }
      : pick
        ? { agentId: pick.id, provider: pick.provider }
        : { provider }),
    ...(model || runProfile.model ? { model: model || runProfile.model } : {}),
  };
  const { status, data } = await client.request("POST", "/api/agent-sessions", {
    body,
    raw: true,
  });
  if (!data?.id)
    throw new SetupError(
      `could not start an assistant session: ${status} ${JSON.stringify(data).slice(0, 300)}`,
    );
  return data;
}

// --profile ID[,model[,effort]]: the seeded server profile the run uses.
const runProfile = { id: "", runtime: "claude", model: "", effort: "high" };

// A paired, connected worker for the signed-in person and their assistant.
async function workerAndAssistant(client, worker, logins) {
  const devicePath = resolve(worker.stack.evalDir, `${worker.name}-device-id`);
  let deviceId = existsSync(devicePath)
    ? readFileSync(devicePath, "utf8").trim()
    : "";
  if (
    !deviceId ||
    !existsSync(resolve(worker.stateRoot, "daemon-config.json"))
  ) {
    deviceId = await worker.pair(client);
    writeFileSync(devicePath, deviceId);
  }
  await worker.start({ logins });
  await worker.waitConnected(client, deviceId, true);
  // The seeded server profile (--profile) is the eval worker's model: bound
  // to it before the assistant exists, the assistant's default right after,
  // so its first project summaries run on it too.
  if (runProfile.id)
    await client.request(
      "PUT",
      `/api/devices/${encodeURIComponent(deviceId)}/profiles`,
      { body: { deviceId, profileIds: [runProfile.id] } },
    );
  let agent = await ensureAssistant(client, deviceId);
  if (
    runProfile.id &&
    agent.settings?.runDefault?.profileId !== runProfile.id
  ) {
    const run = {
      profileId: runProfile.id,
      runtime: runProfile.runtime,
      model: runProfile.model,
      effort: runProfile.effort,
    };
    await client.request("PUT", "/api/personal-agent/settings", {
      body: {
        ...agent.settings,
        runDefault: run,
        assistantProfileId: run.profileId,
        assistantModel: run.model,
        timezone: agent.settings?.timezone || "Asia/Shanghai",
      },
    });
    agent = (await client.get("/api/personal-agent")).agent;
    log(`assistant runs on ${run.profileId} ${run.model} (${run.effort})`);
  }
  // A person whose assistant already lives on one of their computers (offline
  // on the copy) would queue every case for it: the eval's worker is home.
  if (agent.homeDeviceId !== deviceId) {
    log(`moving the assistant to the eval's worker ${deviceId}`);
    await client.post("/api/personal-agent/home", { deviceId });
    agent = (await client.get("/api/personal-agent")).agent;
  }
  log(`assistant workspace ${agent.workspaceId} on ${agent.homeDeviceId}`);
  return { deviceId, agent };
}

// --- (b) end to end with a real model --------------------------------------------

function sampleCases(cases, n, only) {
  if (only.length) {
    const picked = cases.filter((c) => only.includes(c.id));
    const missing = only.filter((id) => !picked.some((c) => c.id === id));
    if (missing.length)
      throw new SetupError(`unknown case ids: ${missing.join(", ")}`);
    return picked;
  }
  // Stratified by gold kind, deterministic: the same sample every run.
  const pool = cases.filter((c) => !c.explicitRef);
  const groups = new Map();
  for (const c of [...pool].sort((a, b) =>
    hash(a.id).localeCompare(hash(b.id)),
  )) {
    const k = goldKind(c);
    groups.set(k, [...(groups.get(k) || []), c]);
  }
  const picked = [];
  const share = (k) =>
    Math.max(2, Math.round((n * (groups.get(k)?.length || 0)) / pool.length));
  for (const [k, list] of groups) picked.push(...list.slice(0, share(k)));
  return picked.slice(0, Math.max(n, groups.size * 2));
}

function turnUsage(events) {
  const usage = {
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
  };
  for (const e of events) {
    const u = e.metadata?.turnUsage;
    if (!u) continue;
    for (const k of Object.keys(usage)) usage[k] += Number(u[k]) || 0;
  }
  return usage;
}

function bannedIn(reply, request) {
  const text = reply
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/https?:\/\/\S+/g, "");
  return bannedTerms
    .filter(([, re, mirror]) => re.test(text) && !mirror.test(request))
    .map(([term]) => term);
}

async function e2eRun(client, worker, agent, deviceId, sample, args, names) {
  // A restart would orphan the project summaries the setup just started.
  if (!worker.pid || !worker.logins) await worker.start({ logins: true });
  await worker.waitConnected(client, deviceId, true);
  const knownWorkspaces = new Set(
    (await client.get("/api/workspaces")).map((w) => w.id),
  );
  const baseline = (await client.get("/api/personal-agent"))?.agent?.settings;
  const devices = new Map(
    (await client.get("/api/devices")).map((d) => [d.id, d]),
  );
  const offline = (await client.get("/api/workspaces"))
    .filter(
      (w) =>
        w.id !== agent.workspaceId &&
        devices.get(w.deviceId)?.status !== "connected",
    )
    .map((w) => {
      const device = w.deviceLabel || devices.get(w.deviceId)?.label || "";
      return {
        id: w.id,
        name: w.name,
        device,
        ref: device ? `${w.name}@${device}` : "",
      };
    });
  summaries.push(...(await waitForSummaries(client, agent, worker.stack)));
  const summaryCost = summaries.reduce((t, x) => t + x.costUsd, 0);
  log(`project summaries: ${summaries.length}, $${summaryCost.toFixed(2)}`);
  const rows = [];
  for (const [i, c] of sample.entries()) {
    await waitForMemory();
    const spent = rows.reduce((t, r) => t + (r.usage?.costUsd || 0), 0);
    if (rows.length >= 3) {
      const projected =
        summaryCost + spent + (spent / rows.length) * (sample.length - i);
      if (projected > args.maxCostUsd) {
        log(
          `stopping before ${c.id}: projected $${projected.toFixed(2)} > $${args.maxCostUsd}`,
        );
        break;
      }
    }
    log(`e2e ${i + 1}/${sample.length} ${c.id}`);
    let session;
    let error = null;
    try {
      session = await startAssistantSession(
        client,
        agent,
        args.provider,
        args.model,
        c.request,
      );
    } catch (e) {
      error = e;
    }
    if (error) {
      rows.push({ id: c.id, error: error.message });
      continue;
    }
    const caseStarted = Date.now();
    const until = caseStarted + args.caseTimeoutS * 1000;
    let detail = session;
    const cancelled = new Set();
    while (Date.now() < until) {
      await sleep(3000);
      detail = await client.get(
        `/api/agent-sessions/${encodeURIComponent(session.id)}`,
      );
      await cancelHelpers(
        client,
        detail,
        agent.workspaceId,
        knownWorkspaces,
        cancelled,
      );
      if (["completed", "failed", "canceled"].includes(detail.status)) break;
    }
    const timedOut = !["completed", "failed", "canceled"].includes(
      detail.status,
    );
    if (timedOut)
      await client
        .post(
          `/api/agent-sessions/${encodeURIComponent(session.id)}/cancel`,
          {},
        )
        .catch(() => {});
    await cancelHelpers(
      client,
      detail,
      agent.workspaceId,
      knownWorkspaces,
      cancelled,
    );
    const events = detail.events || [];
    const tools = events.map(parseToolEvent).filter(Boolean);
    await resetAfterCase(client, tools, knownWorkspaces, baseline);
    // Continuing a helper names its session: the project is the session's.
    for (const t of tools) {
      if (t.args.workspaceId || !t.args.sessionId) continue;
      const helper = await client
        .get(
          `/api/agent-sessions/${encodeURIComponent(String(t.args.sessionId).split("/").pop())}?events=none`,
        )
        .catch(() => null);
      if (helper?.workspaceId) t.args.workspaceId = helper.workspaceId;
    }
    const reply = typeof detail.response === "string" ? detail.response : "";
    const outcome = classifyOutcome(tools, reply, agent.workspaceId, offline);
    rows.push({
      id: c.id,
      sessionId: session.id,
      status: detail.status,
      timedOut,
      wallMs: Date.now() - caseStarted,
      usage: turnUsage(events),
      // Enough of each call to score the row again (rescoreRows).
      tools: tools.map((t) => ({
        name: t.name,
        workspaceId: t.args.workspaceId || "",
        ...(t.args.op ? { op: t.args.op } : {}),
        ...(t.failed ? { failed: true } : {}),
      })),
      proposals: events.filter((e) =>
        /needs_confirmation/.test(JSON.stringify(e.message || e.detail || "")),
      ).length,
      helpersCancelled: cancelled.size,
      reply,
      questions: questionsIn(reply) + cardAsksIn(tools),
      banned: bannedIn(reply, c.request),
      ...outcome,
    });
  }
  await worker.stop();
  e2eOffline.splice(0, e2eOffline.length, ...offline);
  return rows;
}

// The offline projects of the run, for scoring rows again after the judge.
const e2eOffline = [];

// A row scored again from what it stored, with the judge's reading of whether
// the reply asks (classifyOutcome). The first decision stays as
// `decisionByMark` when the reading changed it.
function rescoreRows(rows, assistantWorkspace, verdicts) {
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  for (const r of rows) {
    if (r.error || typeof r.reply !== "string") continue;
    const v = byId.get(r.id);
    const asks = typeof v?.asks === "boolean" ? v.asks : undefined;
    const tools = r.tools.map((t) => ({
      name: t.name,
      args: { workspaceId: t.workspaceId, ...(t.op ? { op: t.op } : {}) },
    }));
    const outcome = classifyOutcome(
      tools,
      r.reply,
      assistantWorkspace,
      e2eOffline,
      { asks },
    );
    const before = r.decisionByMark || r.decision;
    delete r.workspaceId;
    delete r.byMention;
    delete r.judgedAsks;
    delete r.decisionByMark;
    Object.assign(r, outcome, asks === undefined ? {} : { judgedAsks: asks });
    if (before !== r.decision) r.decisionByMark = before;
  }
}

// The first summary of every project runs when the assistant is set up
// (§14); the cases wait for them, one model session at a time otherwise.
async function waitForSummaries(client, agent, stack, timeoutMs = 40 * 60_000) {
  const { DatabaseSync } = await import("node:sqlite");
  const pending = () => {
    const db = new DatabaseSync(stack.dbPath, { readOnly: true });
    try {
      return db
        .prepare(
          "SELECT COUNT(*) AS n FROM workspace_digests WHERE summarized_at = ''",
        )
        .get().n;
    } finally {
      db.close();
    }
  };
  const until = Date.now() + timeoutMs;
  for (let left = pending(); left > 0 && Date.now() < until; left = pending()) {
    log(`waiting for ${left} project summaries`);
    await sleep(20_000);
  }
  // Ended summary sessions leave the list; their usage is in the digest
  // records' sessions, read from the store.
  const db = new DatabaseSync(stack.dbPath, { readOnly: true });
  let rows = [];
  try {
    rows = db
      .prepare(
        "SELECT id, status FROM agent_sessions WHERE workspace_id = ? AND json_extract(payload_json, '$.source') = 'digest'",
      )
      .all(agent.workspaceId);
  } finally {
    db.close();
  }
  const out = [];
  for (const s of rows) {
    const detail = await client
      .get(`/api/agent-sessions/${encodeURIComponent(s.id)}`)
      .catch(() => null);
    out.push({
      id: s.id,
      status: s.status,
      costUsd: turnUsage(detail?.events || []).costUsd,
    });
  }
  log(`project summaries left unsummarized: ${pending()}`);
  return out;
}

// A case starts only while the computer has memory to spare.
async function waitForMemory(minMB = 800) {
  for (;;) {
    const info = readFileSync("/proc/meminfo", "utf8");
    const mb = Number(/MemAvailable:\s+(\d+)/.exec(info)?.[1] || 0) / 1024;
    if (mb >= minMB) return;
    log(`MemAvailable ${Math.round(mb)} MB < ${minMB}: pausing`);
    await sleep(30_000);
  }
}

const summaries = [];

// Each case starts from the same state: projects it created are removed
// from the copy (their folders stay under the worker's scratch HOME), and
// what it remembered or changed in the rules is undone.
async function resetAfterCase(client, tools, knownWorkspaces, baseline) {
  for (const w of await client.get("/api/workspaces").catch(() => [])) {
    if (knownWorkspaces.has(w.id)) continue;
    for (let attempt = 0; attempt < 10; attempt++) {
      const { status } = await client.request(
        "DELETE",
        `/api/workspaces/${encodeURIComponent(w.id)}`,
        { raw: true },
      );
      if (status < 300 || status === 404) break;
      await sleep(3000);
    }
  }
  if (tools.some((t) => t.name === "remember"))
    await client
      .request("DELETE", "/api/personal-agent/memory")
      .catch((e) => log(`could not reset memory: ${e.message}`));
  if (baseline && tools.some((t) => t.name === "update_rules"))
    await client
      .request("PUT", "/api/personal-agent/settings", { body: baseline })
      .catch((e) => log(`could not reset rules: ${e.message}`));
}

// Helpers the assistant starts are cancelled at once: the eval measures where
// work goes, not the work. Its tool calls name the projects; new projects are
// found by comparing the project list.
async function cancelHelpers(
  client,
  detail,
  assistantWorkspace,
  knownWorkspaces,
  cancelled,
) {
  const tools = (detail.events || []).map(parseToolEvent).filter(Boolean);
  const targets = new Set(
    tools
      .filter((t) => DISPATCH_TOOLS.includes(t.name))
      .map((t) => t.args.workspaceId || assistantWorkspace),
  );
  if (tools.some((t) => t.name === "create_workspace")) {
    for (const w of await client.get("/api/workspaces").catch(() => []))
      if (!knownWorkspaces.has(w.id)) targets.add(w.id);
  }
  for (const workspaceId of targets) {
    const sessions = await client
      .get(`/api/agent-sessions?workspaceId=${encodeURIComponent(workspaceId)}`)
      .catch(() => []);
    for (const s of Array.isArray(sessions) ? sessions : []) {
      if (
        s.parentSessionId !== detail.id ||
        cancelled.has(s.id) ||
        !["queued", "running", "blocked"].includes(s.status)
      )
        continue;
      await client
        .post(`/api/agent-sessions/${encodeURIComponent(s.id)}/cancel`, {})
        .catch(() => {});
      cancelled.add(s.id);
    }
  }
}

function scoreE2E(rows, cases, names) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const ok = rows.filter((r) => !r.error && r.status !== "failed");
  const right = (r) => {
    const c = byId.get(r.id);
    const allowed = accepted(c);
    if (r.decision === "project") return allowed.has(r.workspaceId);
    return allowed.has(r.decision);
  };
  const clear = ok.filter((r) => goldKind(byId.get(r.id)) === "project");
  const wentAhead = ok.filter(
    (r) => r.decision === "project" || r.decision === "new",
  );
  // A dispatch to one of an ambiguous case's options is not wrong, only bold.
  const wrongDispatch = wentAhead.filter((r) => {
    const c = byId.get(r.id);
    return (
      !right(r) &&
      !(
        c.gold.target === "ask" &&
        r.decision === "project" &&
        (c.gold.options || []).includes(r.workspaceId)
      )
    );
  });
  const ambiguous = ok.filter((r) => byId.get(r.id).gold.target === "ask");
  const predictedNew = ok.filter((r) => r.decision === "new");
  const goldNew = ok.filter((r) => byId.get(r.id).gold.target === "new");
  const wrongCreations = predictedNew.filter(
    (r) => !accepted(byId.get(r.id)).has("new"),
  );
  const needless = ok.filter(
    (r) => r.decision === "ask" && !accepted(byId.get(r.id)).has("ask"),
  );
  const banned = ok.filter((r) => r.banned.length);
  const metrics = {
    cases: rows.length,
    failed: rows.length - ok.length,
    timedOut: rows.filter((r) => r.timedOut).length,
    routingAccuracy: ratio(ok.filter(right).length, ok.length),
    clearTop1: ratio(clear.filter(right).length, clear.length),
    wrongDispatchRate: ratio(wrongDispatch.length, wentAhead.length),
    askOnAmbiguous: ratio(
      ambiguous.filter((r) => r.decision === "ask").length,
      ambiguous.length,
    ),
    newPrecision: ratio(
      predictedNew.filter((r) => accepted(byId.get(r.id)).has("new")).length,
      predictedNew.length,
    ),
    newRecall: ratio(
      goldNew.filter((r) => r.decision === "new").length,
      goldNew.length,
    ),
    wrongCreations: wrongCreations.length,
    needlessQuestionRate: ratio(needless.length, ok.length),
    questionsPerRequest: ok.length
      ? ok.reduce((s, r) => s + r.questions, 0) / ok.length
      : null,
    bannedTermReplies: banned.length,
    bannedTerms: [...new Set(banned.flatMap((r) => r.banned))],
    latencyMsMedian: median(ok.map((r) => r.wallMs)),
    latencyMsP90: percentile(
      ok.map((r) => r.wallMs),
      0.9,
    ),
    costUsdTotal: round(
      ok.reduce((s, r) => s + r.usage.costUsd, 0),
      4,
    ),
    costUsdPerRequest: ok.length
      ? round(ok.reduce((s, r) => s + r.usage.costUsd, 0) / ok.length, 4)
      : null,
    outputTokensPerRequest: ok.length
      ? Math.round(ok.reduce((s, r) => s + r.usage.outputTokens, 0) / ok.length)
      : null,
    helpersCancelled: rows.reduce((s, r) => s + (r.helpersCancelled || 0), 0),
    decidedByMention: ok.filter((r) => r.byMention).length,
  };
  const checks = [
    gate("e2e: clear top-1", metrics.clearTop1, ">=", gates.clearTop1),
    gate(
      "e2e: wrong dispatch when going ahead",
      metrics.wrongDispatchRate,
      "<=",
      gates.wrongDispatch,
    ),
    gate(
      "e2e: asks on ambiguous",
      metrics.askOnAmbiguous,
      ">=",
      gates.askOnAmbiguous,
    ),
    gate("e2e: new precision", metrics.newPrecision, ">=", gates.newPrecision),
    gate("e2e: new recall", metrics.newRecall, ">=", gates.newRecall),
    gate(
      "e2e: replies with banned words",
      metrics.bannedTermReplies,
      "<=",
      gates.bannedTerms,
      false,
    ),
    gate(
      "e2e: questions per request",
      metrics.questionsPerRequest,
      "<=",
      gates.questionsPerRequest,
      false,
    ),
  ];
  const misses = ok
    .filter((r) => !right(r))
    .map((r) => {
      const c = byId.get(r.id);
      return {
        id: r.id,
        request: c.request.slice(0, 80),
        gold: names.get(c.gold.target) || c.gold.target,
        got:
          r.decision === "project"
            ? names.get(r.workspaceId) || r.workspaceId
            : r.decision,
        sessionId: r.sessionId,
      };
    });
  return { metrics, checks, misses };
}

// Read-only Foundry sessions rate the replies, a batch at a time; no direct
// model call. Per reply: plain language, more than one question, and whether
// it asks the person (the ask reading classifyOutcome uses: free text, so a
// model reads it, not a word list). On a seeded server profile (--profile)
// the judge runs on it too.
const judgeBatch = 20;

async function judgeReplies(client, worker, deviceId, rows, cases, args) {
  const judged = rows.filter((r) => r.reply);
  if (!judged.length) return null;
  const folder = resolve(worker.home, "pa-eval-judge");
  mkdirSync(folder, { recursive: true });
  // Registering the folder asks the worker: it must be connected first. The
  // e2e run just stopped it; until the server has seen that connection end,
  // the device still reads as connected and the new one is not yet in use.
  await worker.stop();
  await worker
    .waitConnected(client, deviceId, false, 60_000)
    .catch(() =>
      log("the worker still reads as connected; starting it anyway"),
    );
  await worker.start({ logins: true });
  await worker.waitConnected(client, deviceId, true);
  const workspace = await client.post("/api/workspaces", {
    deviceId,
    path: folder,
  });
  const byId = new Map(cases.map((c) => [c.id, c]));
  const verdicts = [];
  const sessions = [];
  let costUsd = 0;
  try {
    for (let at = 0; at < judged.length; at += judgeBatch) {
      const items = judged.slice(at, at + judgeBatch).map((r) => ({
        id: r.id,
        request: byId.get(r.id).request,
        reply: r.reply,
      }));
      const prompt = [
        "You are rating replies a personal assistant gave to a non-technical person. Do not use any tools and do not change any files.",
        "For each item decide:",
        "- plain: the reply is plain, human language a non-technical person understands at once (no software jargon they did not use themselves, no ids, no file paths).",
        "- multipleQuestions: it asked more than one question.",
        "- asks: the reply leaves the next step to the person by asking them to choose, confirm or supply something (which one of several things, a missing link, name, file or text, a yes/no) before the assistant goes on, with or without a question mark, including a numbered list of options to pick from. false when it answers, reports, or says it will do the work, and any question is only an optional offer on top. Saying a computer is offline and the work starts once it is back is not asking.",
        'Answer with only a JSON array, one object per item: {"id": "...", "plain": true|false, "multipleQuestions": true|false, "asks": true|false, "reason": "<= 15 words"}.',
        "",
        JSON.stringify(items, null, 1),
      ].join("\n");
      const session = await client.post("/api/agent-sessions", {
        workspaceId: workspace.id,
        prompt,
        source: "chat",
        ...(runProfile.id
          ? { provider: runProfile.runtime, profileId: runProfile.id }
          : { provider: args.provider }),
        ...(args.model || runProfile.model
          ? { model: args.model || runProfile.model }
          : {}),
        codexSandboxMode: "read-only",
        codexApprovalPolicy: "never",
        claudePermissionMode: "dontAsk",
      });
      sessions.push(session.id);
      const until = Date.now() + 600_000;
      let detail = session;
      while (
        Date.now() < until &&
        !["completed", "failed", "canceled"].includes(detail.status)
      ) {
        await sleep(4000);
        detail = await client.get(
          `/api/agent-sessions/${encodeURIComponent(session.id)}`,
        );
      }
      costUsd += turnUsage(detail.events || []).costUsd;
      const batch = parseJudgeAnswer(detail.response || "");
      const wanted = new Set(items.map((x) => x.id));
      verdicts.push(...batch.filter((v) => wanted.has(v.id)));
      log(
        `judge batch ${at / judgeBatch + 1}: ${batch.length}/${items.length} verdicts`,
      );
    }
    return {
      sessionIds: sessions,
      costUsd: round(costUsd, 4),
      judged: judged.length,
      verdictCount: verdicts.length,
      plainShare: ratio(
        verdicts.filter((v) => v.plain).length,
        verdicts.length,
      ),
      notPlain: verdicts
        .filter((v) => !v.plain)
        .map((v) => ({ id: v.id, reason: v.reason })),
      multipleQuestions: verdicts
        .filter((v) => v.multipleQuestions)
        .map((v) => v.id),
      verdicts,
    };
  } finally {
    await worker.stop();
  }
}

// --- report ----------------------------------------------------------------------

function ratio(a, b) {
  return b ? round(a / b, 4) : null;
}

function round(x, digits) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function median(xs) {
  return percentile(xs, 0.5);
}

function percentile(xs, p) {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function gate(name, value, op, bound, ratio = true) {
  const pass =
    value === null || value === undefined
      ? null
      : op === ">="
        ? value >= bound
        : value <= bound;
  return { name, value, op, bound, pass, ratio };
}

// Metrics that are shares, printed as percentages.
const ratioMetrics = new Set([
  "routingAccuracy",
  "clearTop1",
  "wrongDispatchRate",
  "askOnAmbiguous",
  "newPrecision",
  "newRecall",
  "needlessQuestionRate",
]);

function printReport(report) {
  const fmt = (v, isRatio) =>
    v === null || v === undefined
      ? "n/a"
      : isRatio && typeof v === "number"
        ? `${(v * 100).toFixed(1)}%`
        : String(v);
  const lines = [];
  for (const part of ["e2e"]) {
    const r = report[part];
    if (!r) continue;
    lines.push(`\n## ${part}`);
    for (const [k, v] of Object.entries(r.metrics))
      lines.push(
        `  ${k.padEnd(24)} ${typeof v === "object" && v !== null ? JSON.stringify(v) : fmt(v, ratioMetrics.has(k))}`,
      );
    if (r.misses?.length) {
      lines.push(`  misses (${r.misses.length}):`);
      for (const m of r.misses.slice(0, 25))
        lines.push(
          `    ${m.id}  gold ${m.gold}  got ${Array.isArray(m.got) ? m.got.join(" | ") : m.got}  «${m.request.replace(/\n/g, " ")}»`,
        );
    }
    if (r.errors?.length)
      lines.push(
        `  errors (${r.errors.length}): ${r.errors
          .slice(0, 3)
          .map((e) => `${e.id}: ${e.error}`)
          .join("; ")}`,
      );
  }
  if (report.scenario)
    lines.push(
      `\n## scenario A1/A2 (session ${report.scenario.sessionId})\n  A1 first reply: ${report.scenario.firstReply.slice(0, 160)}\n  A1 report:      ${report.scenario.reportReply.slice(0, 160)}\n  A2 reply:       ${report.scenario.a2Reply.slice(0, 160)}`,
    );
  if (report.plans)
    lines.push(
      `\n## scenario plans (session ${report.plans.sessionId})\n  first reply:  ${report.plans.firstReply}\n  second reply: ${report.plans.secondReply}\n  list:\n${report.plans.items.map((item) => `    - [${item.status}] ${item.text} (${item.when || "-"}${item.remind ? `, remind ${item.at}` : ""})`).join("\n")}`,
    );
  if (report.judge?.error)
    lines.push(`\n## judge\n  failed: ${report.judge.error}`);
  else if (report.judge)
    lines.push(
      `\n## judge\n  plain replies ${fmt(report.judge.plainShare, true)}; not plain: ${report.judge.notPlain.map((x) => x.id).join(", ") || "none"}`,
    );
  lines.push("\n## gates");
  for (const c of report.checks)
    lines.push(
      `  ${c.pass === null ? "SKIP" : c.pass ? "PASS" : "FAIL"}  ${c.name}: ${fmt(c.value, c.ratio)} (${c.op} ${fmt(c.bound, c.ratio)})`,
    );
  console.log(lines.join("\n"));
}

async function runRoutingAndE2E(
  client,
  worker,
  agent,
  deviceId,
  cases,
  names,
  args,
  report,
) {
  if (args.e2e) {
    const sample = sampleCases(cases, args.sample, args.only);
    const rows = await e2eRun(
      client,
      worker,
      agent,
      deviceId,
      sample,
      args,
      names,
    );
    report.e2e = {
      ...scoreE2E(rows, cases, names),
      rows,
      summaries,
      assistantWorkspace: agent.workspaceId,
      offline: e2eOffline,
    };
    report.checks.push(...report.e2e.checks);
    // The rows are the run's result: a judge that fails must not lose them.
    if (args.judge) {
      report.judge = await judgeReplies(
        client,
        worker,
        deviceId,
        rows,
        cases,
        args,
      ).catch((error) => {
        log(`the judge failed: ${error.message}`);
        return { error: error.message };
      });
      // The judge's reading of whether a reply asks replaces the question
      // mark; the scores are taken again from the stored rows.
      if (report.judge?.verdicts?.length) {
        rescoreRows(rows, agent.workspaceId, report.judge.verdicts);
        const scored = scoreE2E(rows, cases, names);
        report.e2e.byMark = {
          metrics: report.e2e.metrics,
          checks: report.e2e.checks,
          misses: report.e2e.misses,
        };
        Object.assign(report.e2e, scored);
        report.checks = report.checks.filter(
          (c) => !c.name.startsWith("e2e: "),
        );
        report.checks.push(...scored.checks);
      }
    }
  }
}

// --- A1 + A2: an account whose only project is the assistant's -----------------

const a1Request = "帮我做一个记家庭开销的小网页";
const a2Request = "加个导出 Excel";

async function scenarioA1A2(stack, args) {
  const username = "pa-eval-fresh";
  const password = randomBytes(18).toString("base64url");
  stack.createUser(username, password);
  const client = new Client(stack.url);
  await client.post("/api/auth/login", { username, password });
  const worker = new Worker(stack, args.workerHome, "fresh", args.provider);
  activeWorkers.add(worker);
  try {
    const { agent } = await workerAndAssistant(client, worker, true);
    const before = (await client.get("/api/workspaces")).map((w) => w.id);
    const onlyAssistant =
      before.length === 1 && before[0] === agent.workspaceId;
    const session = await startAssistantSession(
      client,
      agent,
      args.provider,
      args.model,
      a1Request,
    );
    const until = Date.now() + args.scenarioTimeoutS * 1000;

    // A1: the first turn creates a project and starts work there; once the
    // helper is done the assistant reports again, with a link.
    let detail = await settle(client, session.id, until);
    const firstTurnEvents = (detail.events || []).length;
    const firstReply = detail.response || "";
    const a1Tools = (detail.events || []).map(parseToolEvent).filter(Boolean);
    const created = (await client.get("/api/workspaces"))
      .map((w) => w.id)
      .filter((id) => !before.includes(id));
    const helperDone = async () => {
      if (!created.length) return true;
      const helpers = await client
        .get(
          `/api/agent-sessions?workspaceId=${encodeURIComponent(created[0])}`,
        )
        .catch(() => []);
      return (Array.isArray(helpers) ? helpers : [])
        .filter((h) => h.parentSessionId === session.id)
        .every((h) => ["completed", "failed", "canceled"].includes(h.status));
    };
    while (
      Date.now() < until &&
      (!(await helperDone()) ||
        (detail.events || []).length === firstTurnEvents ||
        !["completed", "failed", "canceled"].includes(detail.status))
    ) {
      await sleep(10_000);
      detail = await client.get(
        `/api/agent-sessions/${encodeURIComponent(session.id)}`,
      );
    }
    const reportReply = detail.response || "";
    const linked =
      /\]\([^)]+\)|https?:\/\/\S+/.test(reportReply) &&
      reportReply !== firstReply;

    // A2: the follow-up in the same conversation.
    const eventsBeforeA2 = (detail.events || []).length;
    await client.post(
      `/api/agent-sessions/${encodeURIComponent(session.id)}/messages`,
      { prompt: a2Request },
    );
    await sleep(3000);
    detail = await settle(
      client,
      session.id,
      Date.now() + args.caseTimeoutS * 1000,
    );
    const a2Tools = (detail.events || [])
      .slice(eventsBeforeA2)
      .map(parseToolEvent)
      .filter(Boolean);
    for (const t of a2Tools) {
      if (t.args.workspaceId || !t.args.sessionId) continue;
      const helper = await client
        .get(
          `/api/agent-sessions/${encodeURIComponent(String(t.args.sessionId).split("/").pop())}?events=none`,
        )
        .catch(() => null);
      if (helper?.workspaceId) t.args.workspaceId = helper.workspaceId;
    }
    const a2Targets = a2Tools
      .filter((t) => ["create_session", "send_message"].includes(t.name))
      .map((t) => t.args.workspaceId);
    const after = (await client.get("/api/workspaces")).map((w) => w.id);
    const cancelled = new Set();
    await cancelHelpers(
      client,
      detail,
      agent.workspaceId,
      new Set(after),
      cancelled,
    );

    const checks = [
      gate(
        "A1: only the assistant's project before",
        onlyAssistant ? 1 : 0,
        ">=",
        1,
      ),
      gate(
        "A1: created one project",
        created.length === 1 &&
          a1Tools.some((t) => t.name === "create_workspace")
          ? 1
          : 0,
        ">=",
        1,
      ),
      gate(
        "A1: started work there",
        a1Tools.some(
          (t) =>
            t.name === "create_session" && t.args.workspaceId === created[0],
        )
          ? 1
          : 0,
        ">=",
        1,
      ),
      gate(
        "A1: replies without banned words",
        bannedIn(firstReply, a1Request).length +
          bannedIn(reportReply, a1Request).length,
        "<=",
        0,
      ),
      gate("A1: reported the result with a link", linked ? 1 : 0, ">=", 1),
      gate(
        "A2: went to the A1 project",
        a2Targets.length && a2Targets.every((w) => w === created[0]) ? 1 : 0,
        ">=",
        1,
      ),
      gate(
        "A2: created nothing new",
        after.length === before.length + created.length &&
          !a2Tools.some((t) => t.name === "create_workspace")
          ? 1
          : 0,
        ">=",
        1,
      ),
    ];
    return {
      sessionId: session.id,
      createdWorkspace: created[0] || "",
      firstReply,
      reportReply,
      a2Reply: detail.response || "",
      // Pass/fail and counts, not shares.
      checks: checks.map((c) => ({ ...c, ratio: false })),
    };
  } finally {
    await worker.stop();
    activeWorkers.delete(worker);
  }
}

// The person's message from real use (dev, 2026-10-15), the document link
// left out.
const plansRequest =
  "几个事情啊，一个是我昨晚联系了很多猎头，然后他们的一些微信消息我还没有回复。下班再搞。另外是下班也回去看一下脉脉有没有新信息，要礼貌回复\n" +
  "然后是我下午要去给大家捋一下现在Atlas的流程，以及我想提出说把Atlas流程跟Tag流程给合并一下。正在写文档，还在修订中。得赶紧干完，在尽量在下午能够拉齐一个会议去说这个事情。\n\n" +
  "然后刚刚跟小林，也就是QA对了一下，他们有在维护一个提测这样的Workflow，然后我们后续看看可以直接调他的提测Workflow。";
const plansFollowUp = "我一般 7 点下班，到时提醒我";
// An offer to set up a meeting or reach other people for the person.
const meetingOffer =
  /(我(来|去|帮你)?(约|拉|订|安排|发|通知|邀请)|帮你(约|拉|订|安排|发|通知|邀请|找)|要不要我.{0,12}(约|拉|安排|通知|邀请)|都有空的时间|告诉我.{0,8}(名字|哪些人)|(book|schedule|set up|arrange) (a|the) meeting|invite)/i;

// --scenario plans: the person's list from their own words (see the usage).
async function scenarioPlans(client, worker, deviceId, args) {
  let { agent } = { agent: (await client.get("/api/personal-agent"))?.agent };
  if (!agent) throw new SetupError(`${args.user} has no assistant on the copy`);
  if (agent.homeDeviceId !== deviceId) {
    log(`moving the assistant to the sandboxed worker ${deviceId}`);
    agent = await client.post("/api/personal-agent/home", { deviceId });
  }
  await client.request("PUT", "/api/personal-agent/settings", {
    body: {
      ...agent.settings,
      timezone: agent.settings.timezone || "Asia/Shanghai",
    },
  });
  agent = (await client.get("/api/personal-agent")).agent;
  const location = agent.settings.timezone;
  const technical = [
    ...(await client.get("/api/workspaces")).map((w) => w.name),
    ...(await client.get("/api/devices")).map((d) => d.label),
  ].filter(
    (name) => name && /^[\x21-\x7e]+$/.test(name) && /[-_.\d]/.test(name),
  );
  const knownWorkspaces = new Set(
    (await client.get("/api/workspaces")).map((w) => w.id),
  );
  const listed = async () =>
    client.get(
      `/api/personal-agent/list?closedSince=${encodeURIComponent(new Date(Date.now() - 6 * 3600_000).toISOString())}`,
    );
  const before = new Set((await listed()).map((item) => item.id));

  const session = await startAssistantSession(
    client,
    agent,
    args.provider,
    args.model,
    plansRequest,
  );
  let detail = await settle(
    client,
    session.id,
    Date.now() + args.caseTimeoutS * 1000,
  );
  const firstReply = detail.response || "";
  const firstTools = (detail.events || []).map(parseToolEvent).filter(Boolean);
  const items = (await listed()).filter((item) => !before.has(item.id));
  const has = (re, status) =>
    items.some(
      (item) => re.test(item.text) && (!status || item.status === status),
    );

  const eventsBefore = (detail.events || []).length;
  await client.post(
    `/api/agent-sessions/${encodeURIComponent(session.id)}/messages`,
    { prompt: plansFollowUp },
  );
  await sleep(3000);
  detail = await settle(
    client,
    session.id,
    Date.now() + args.caseTimeoutS * 1000,
  );
  const secondReply = detail.response || "";
  const secondTools = (detail.events || [])
    .slice(eventsBefore)
    .map(parseToolEvent)
    .filter(Boolean);
  const after = (await listed()).filter((item) => !before.has(item.id));
  const at19 = (item) =>
    item.remind &&
    item.at &&
    new Date(item.at).toLocaleTimeString("en-GB", {
      timeZone: location,
      hour: "2-digit",
      minute: "2-digit",
    }) === "19:00";
  const reminded = after.filter((item) => /猎头|微信|脉脉/.test(item.text));
  await cancelHelpers(
    client,
    detail,
    agent.workspaceId,
    knownWorkspaces,
    new Set(),
  );

  const replies = firstReply + "\n" + secondReply;
  const named = technical.filter((name) => replies.includes(name));
  const checks = [
    gate(
      "plans: four things on the list",
      [/猎头|微信/, /脉脉/, /atlas|tag/i].filter((re) => has(re, "open"))
        .length + (has(/小林|QA|提测/i, "done") ? 1 : 0),
      ">=",
      4,
    ),
    gate(
      "plans: no offer to contact anyone",
      meetingOffer.test(replies) ? 1 : 0,
      "<=",
      0,
    ),
    gate(
      "plans: no banned words",
      bannedIn(firstReply, plansRequest).length +
        bannedIn(secondReply, plansRequest + plansFollowUp).length,
      "<=",
      0,
    ),
    gate("plans: no technical names", named.length, "<=", 0),
    gate(
      "plans: reminders at 19:00 on the after-work items",
      reminded.length >= 2 && reminded.every(at19) ? 1 : 0,
      ">=",
      1,
    ),
  ];
  return {
    sessionId: session.id,
    firstReply,
    secondReply,
    firstTools: firstTools.map((t) => t.name),
    secondTools: secondTools.map((t) => t.name),
    items: after.map(({ id, text, when, at, remind, status }) => ({
      id,
      text,
      when,
      at,
      remind,
      status,
    })),
    technicalNamed: named,
    checks: checks.map((c) => ({ ...c, ratio: false })),
  };
}

async function settle(client, sessionId, until) {
  let detail;
  do {
    await sleep(3000);
    detail = await client.get(
      `/api/agent-sessions/${encodeURIComponent(sessionId)}`,
    );
  } while (
    Date.now() < until &&
    !["completed", "failed", "canceled"].includes(detail.status)
  );
  return detail;
}

const activeWorkers = new Set();

// --rescore FILE: a stored report scored again, in place, with the current
// scorer and the judge verdicts it holds (report.judge.verdicts). The
// offline projects come from the report or, for older reports, from the eval
// set's index (the fixture's computers are the index's).
function rescoreReport(file) {
  const path = resolve(file);
  const report = JSON.parse(readFileSync(path, "utf8"));
  const { cases, index, names } = loadEvalSet(
    resolve(homedir(), ".foundry/pa-eval/set"),
  );
  const offline =
    report.e2e.offline ||
    index.projects.map((p) => ({
      id: p.workspaceId,
      name: p.name,
      device: p.computer,
      ref: p.ref,
    }));
  e2eOffline.splice(0, e2eOffline.length, ...offline);
  const assistant = report.e2e.assistantWorkspace || "";
  rescoreRows(report.e2e.rows, assistant, report.judge?.verdicts || []);
  const scored = scoreE2E(report.e2e.rows, cases, names);
  Object.assign(report.e2e, scored, { offline, assistantWorkspace: assistant });
  report.checks = [
    ...report.checks.filter((c) => !c.name.startsWith("e2e: ")),
    ...scored.checks,
  ];
  report.rescoredAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  printReport(report);
  return report.checks.some((c) => c.pass === false) ? 1 : 0;
}

// --- main ------------------------------------------------------------------------

async function main() {
  if (process.argv.includes("--sandbox-check")) process.exit(sandboxCheck());
  const rescoreAt = process.argv.indexOf("--rescore");
  if (rescoreAt > 0) process.exit(rescoreReport(process.argv[rescoreAt + 1]));
  const args = parseArgs(process.argv);
  const { cases, names } = loadEvalSet(args.evalDir);
  const stack = new Stack(args.instance, args.stackDir);
  const worker = new Worker(stack, args.workerHome, "worker", args.provider);
  const report = {
    startedAt: new Date().toISOString(),
    instance: args.instance,
    cases: cases.length,
    checks: [],
  };
  let failed = false;
  try {
    // A fresh seeded database holds no eval chats to hide, and the run signs
    // in as its own synthetic user, never the person.
    await stack.up();
    const username = args.user;
    const password = stack.password();
    const client = new Client(stack.url);
    await client.post("/api/auth/login", { username, password });
    log(`signed in as ${username} on ${stack.url}`);

    if (args.e2e) {
      // The assistant reads the project summary files natively; the eval
      // scores the workspace it dispatched to.
      const { deviceId, agent } = await workerAndAssistant(
        client,
        worker,
        true,
      );
      await runRoutingAndE2E(
        client,
        worker,
        agent,
        deviceId,
        cases,
        names,
        args,
        report,
      );
    }
    if (args.scenario === "a1a2") {
      report.scenario = await scenarioA1A2(stack, args);
      report.checks.push(...report.scenario.checks);
    }
    if (args.scenario === "plans") {
      const { deviceId } = await workerAndAssistant(client, worker, true);
      report.plans = await scenarioPlans(client, worker, deviceId, args);
      report.checks.push(...report.plans.checks);
    }
    failed = report.checks.some((c) => c.pass === false);
  } catch (error) {
    await worker.stop().catch(() => {});
    for (const w of activeWorkers) await w.stop().catch(() => {});
    stack.down();
    console.error(
      `pa-eval: ${error instanceof SetupError ? "" : "unexpected error: "}${error.message}`,
    );
    if (!(error instanceof SetupError)) console.error(error.stack);
    process.exit(2);
  }
  await worker.stop();
  report.finishedAt = new Date().toISOString();
  const out =
    args.out ||
    resolve(
      args.keep
        ? stack.evalDir
        : resolve(process.env.TMPDIR || tmpdir(), "pa-eval-reports"),
      `report-${report.startedAt.replace(/[:.]/g, "-")}.json`,
    );
  mkdirSync(resolve(out, ".."), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  printReport(report);
  console.log(`\nreport: ${out}`);
  stack.down();
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(`pa-eval: ${error.stack || error.message}`);
  process.exit(2);
});
