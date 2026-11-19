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
//                      after each case. The copy's projects sit on
//                      fixture computers, online with a stand-in runtime (the
//                      fake Claude CLI, one Worker each): a dispatch is a real
//                      session. The decision is a dispatch tool call or an ask;
//                      a reply naming a project is a diagnostic only. The worker runs in bubblewrap (home
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

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
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
  blockingAsksOf,
  classifyOutcome,
  DISPATCH_TOOLS,
  cardAsksIn,
  parseJudgeAnswer,
  parseToolEvent,
  questionsIn,
} from "./pa-eval-score.mjs";
import { appendRow, journalKey, readJournal } from "./pa-eval-journal.mjs";

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
    repeat: 1,
    resume: "",
    resumed: new Map(),
    journal: "",
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
      case "--resume":
        args.resume = value();
        break;
      case "--repeat": {
        args.repeat = Number(value());
        if (!Number.isInteger(args.repeat) || args.repeat < 1)
          throw new Error("--repeat needs a whole number of at least 1");
        break;
      }
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
    // Run the runtime under the sandbox even without the person's logins.
    this.sandboxed = false;
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
    // Tools and the npm cache are one shared folder per stack: a Worker's home
    // would otherwise take about 0.6 GB of its own (the runtime itself is
    // read-only in the sandbox and never copied).
    const shared = resolve(this.stack.evalDir, "shared");
    for (const folder of ["tools", "npm-cache", "xdg-cache", "go-build"])
      mkdirSync(resolve(shared, folder), { recursive: true, mode: 0o700 });
    const env = {
      ...inherited,
      FOUNDRY_TOOLS_ROOT: resolve(shared, "tools"),
      NPM_CONFIG_CACHE: resolve(shared, "npm-cache"),
      XDG_CACHE_HOME: resolve(shared, "xdg-cache"),
      GOCACHE: resolve(shared, "go-build"),
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
        `--token=${token}`,
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
    const [file, ...argv] =
      logins || this.sandboxed
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

// --- fixture computers, online with a stand-in runtime ---------------------------

const fakeClaudeSource = resolve(root, "scripts/fixtures/fake-claude-code.cjs");

// One Worker per fixture computer, paired under the sandbox. Only the model is
// faked: the Worker's Claude runtime is the fake CLI (FOUNDRY_CLAUDE_BIN, as in
// scripts/ci-worker-restart.mjs), so a project on the computer is online and a
// dispatch to it is a real session.
class FixtureWorker extends Worker {
  constructor(stack, computer, deviceId, name) {
    super(stack, "scratch", name, "claude");
    this.computer = computer;
    this.deviceId = deviceId;
    this.realLogins = false;
    this.sandboxed = true;
    this.fakeClaude = resolve(stack.evalDir, "fixtures/claude");
  }

  env({ logins }) {
    return { ...super.env({ logins }), FOUNDRY_CLAUDE_BIN: this.fakeClaude };
  }

  // The seed left the computer's device id free (no identity row), so a
  // pairing that asks for it keeps the id and the projects stay on it.
  async pair(client) {
    mkdirSync(this.stateRoot, { recursive: true, mode: 0o700 });
    writeFileSync(
      resolve(this.stateRoot, "device.json"),
      JSON.stringify({
        id: this.deviceId,
        label: this.computer,
        status: "connected",
        lastSeenLabel: "online",
      }),
      { mode: 0o600 },
    );
    const id = await super.pair(client);
    if (id !== this.deviceId)
      throw new SetupError(
        `${this.computer} paired as ${id}, not ${this.deviceId}`,
      );
    return id;
  }
}

// Pairs and starts every computer of the fixture, then waits until each shows
// as connected. The fake CLI is copied into the stack, never run from the repo.
async function startFixtureWorkers(client, stack, index) {
  const fixtureDir = resolve(stack.evalDir, "fixtures");
  mkdirSync(fixtureDir, { recursive: true, mode: 0o700 });
  copyFileSync(fakeClaudeSource, resolve(fixtureDir, "claude"));
  chmodSync(resolve(fixtureDir, "claude"), 0o755);
  const ids = new Map(
    (await client.get("/api/devices")).map((d) => [d.label, d.id]),
  );
  const computers = [...new Set(index.projects.map((p) => p.computer))];
  const fixtures = [];
  for (const [i, computer] of computers.entries()) {
    const deviceId = ids.get(computer);
    if (!deviceId)
      throw new SetupError(`no seeded device for the computer ${computer}`);
    const fixture = new FixtureWorker(
      stack,
      computer,
      deviceId,
      `fixture-${i + 1}`,
    );
    await fixture.pair(client);
    await fixture.start({ logins: false });
    activeWorkers.add(fixture);
    fixtures.push(fixture);
  }
  for (const fixture of fixtures)
    await fixture.waitConnected(client, fixture.deviceId, true);
  fixtureWorkers.splice(0, fixtureWorkers.length, ...fixtures);
  sampleFixtureMemory();
  log(
    `fixture computers online: ${fixtures.length} (RSS ${fixtureMemory.firstTotalMb?.rss} MB, PSS ${fixtureMemory.firstTotalMb?.pss} MB)`,
  );
  return fixtures;
}

// Resident memory of the fixture: each Worker's process tree (its sandbox and
// the runtime it starts), sampled before each case. Kept: the first total and
// the largest seen, per computer and in all.
const fixtureWorkers = [];
const fixtureMemory = {
  computers: 0,
  samples: 0,
  firstTotalMb: null,
  maxTotalMb: {},
  maxPerComputerMb: [],
};

// Memory of a process tree: RSS (what ps reports; shared pages count in every
// process that maps them) and PSS (each process's share of them, the honest
// total), in MB.
function treeMemoryMb(rootPid) {
  const table = execFileSync("ps", ["-e", "-o", "pid=,ppid=,rss="], {
    encoding: "utf8",
  });
  const rss = new Map();
  const children = new Map();
  for (const line of table.trim().split("\n")) {
    const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
    rss.set(pid, kb);
    children.set(ppid, [...(children.get(ppid) || []), pid]);
  }
  let rssKb = 0;
  let pssKb = 0;
  const pending = [rootPid];
  for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
    rssKb += rss.get(pid) || 0;
    pssKb += pssOfKb(pid);
    pending.push(...(children.get(pid) || []));
  }
  return { rssMb: rssKb / 1024, pssMb: pssKb / 1024 };
}

function pssOfKb(pid) {
  try {
    const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    return Number(/^Pss:\s+(\d+)/m.exec(rollup)?.[1] || 0);
  } catch {
    return 0;
  }
}

function sampleFixtureMemory() {
  const perComputer = fixtureWorkers.map((w) =>
    w.pid ? treeMemoryMb(w.pid) : { rssMb: 0, pssMb: 0 },
  );
  const rssTotal = perComputer.reduce((sum, m) => sum + m.rssMb, 0);
  const pssTotal = perComputer.reduce((sum, m) => sum + m.pssMb, 0);
  fixtureMemory.computers = fixtureWorkers.length;
  fixtureMemory.samples++;
  fixtureMemory.firstTotalMb ??= {
    rss: round(rssTotal, 1),
    pss: round(pssTotal, 1),
  };
  fixtureMemory.maxTotalMb = {
    rss: round(Math.max(fixtureMemory.maxTotalMb.rss ?? 0, rssTotal), 1),
    pss: round(Math.max(fixtureMemory.maxTotalMb.pss ?? 0, pssTotal), 1),
  };
  fixtureMemory.maxPerComputerMb = perComputer.map((m, i) => ({
    rss: round(
      Math.max(fixtureMemory.maxPerComputerMb[i]?.rss ?? 0, m.rssMb),
      1,
    ),
    pss: round(
      Math.max(fixtureMemory.maxPerComputerMb[i]?.pss ?? 0, m.pssMb),
      1,
    ),
  }));
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

// Whether a recorded pid still runs what the harness started: an exact argument
// of its command line, never a name match (another session may run the same
// program, and only pids this run wrote to its pid files are ever signalled).
function isOurs(pid, needle) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .includes(needle);
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

// The web home sends a message as the assistant's own inbox entry
// (use-assistant-conversation.ts send -> capturePersonalAgentInbox -> POST
// /api/personal-agent/inbox, origin web). The server delivers the entry to the
// assistant's conversation and records the session on it (entry.sessionId);
// the per-turn context (the Now line and the receipt) is added on that path
// (instructions.go). The model is the assistant's run default (--profile).
async function captureInboxTurn(client, text, timeoutMs) {
  const messageId = randomUUID();
  let entry = await client.post("/api/personal-agent/inbox", {
    text,
    messageId,
  });
  const until = Date.now() + timeoutMs;
  while (!entry.sessionId) {
    if (["failed", "cancelled", "canceled"].includes(entry.status)) {
      await dismissInboxEntry(client, entry);
      throw new Error(
        `inbox entry ${entry.status}: ${entry.resultError || entry.waitingReason || ""}`.trim(),
      );
    }
    if (Date.now() >= until) {
      // Left pending, it would be delivered into the next case.
      await dismissInboxEntry(client, entry);
      throw new Error(
        `inbox entry not delivered in time (status ${entry.status}, waiting: ${entry.waitingReason || "none"})`,
      );
    }
    await sleep(2000);
    entry = (await client.get("/api/personal-agent/inbox")).find(
      (e) => e.id === entry.id,
    );
    if (!entry) throw new Error("inbox entry disappeared");
  }
  return entry;
}

// The person's "不再处理" on an entry that never got a session: it is
// cancelled, nothing new is dispatched (inbox.go DismissInbox).
async function dismissInboxEntry(client, entry) {
  await client
    .post(`/api/personal-agent/inbox/${encodeURIComponent(entry.id)}/action`, {
      action: "dismiss",
      revision: entry.revision,
      requestId: randomUUID(),
    })
    .catch((e) => log(`could not dismiss inbox ${entry.id}: ${e.message}`));
}

// A fresh conversation for the next case: the server continues the newest web
// conversation unless it is archived (deliverInbox skips archived sessions:
// ListAgentSessionSummaries excludes them). Archiving is the person's own
// chat-archive action, on the copy.
async function archiveConversation(client, workspaceId, sessionId) {
  if (!sessionId) return;
  const result = await client.post("/api/chats/archive", {
    workspaceId,
    chatIds: [sessionId],
  });
  if (!result?.archived?.includes(sessionId))
    throw new Error(
      `archive of ${sessionId} did not archive it: ${JSON.stringify(result).slice(0, 200)}`,
    );
}

async function itemIds(client) {
  const page = await client.get("/api/personal-agent/items");
  return new Set(
    (Array.isArray(page) ? page : page?.items || []).map((i) => i.id),
  );
}

// The policy tag (docs/personal-agent.md §13, the set's overrides): run and
// reported, not part of the routing metrics.
const isPolicyCase = (c) =>
  c.policy === true || (Array.isArray(c.tags) && c.tags.includes("policy"));

// Redacted requests the request alone cannot support (tag
// unanswerable-as-redacted): run, reported apart, not in routing metrics.
const isUnanswerableCase = (c) =>
  c["unanswerable-as-redacted"] === true ||
  (Array.isArray(c.tags) && c.tags.includes("unanswerable-as-redacted"));

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

async function e2eRun(
  client,
  worker,
  agent,
  deviceId,
  sample,
  args,
  names,
  repeat = 1,
) {
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
  // Every project the assistant can route to, as a reply may name it. The
  // mention diagnostic reads these; the decision never does.
  const projects = (await client.get("/api/workspaces"))
    .filter((w) => w.id !== agent.workspaceId)
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
  if (!runProfile.id && args.model)
    throw new SetupError(
      "the inbox path takes the model from the assistant's run default: pass --profile ID[,model[,effort]]",
    );
  const rows = [];
  // Each finished case is journaled as it ends (see pa-eval-journal.mjs).
  const record = (row) => {
    rows.push(row);
    appendRow(args.journal, repeat, row);
  };
  // The previous case's conversation: a case that lands in it carries over.
  let previousSessionId = "";
  const baselineItems = await itemIds(client);
  for (const [i, c] of sample.entries()) {
    const done = args.resumed.get(journalKey(repeat, c.id));
    if (done) {
      log(`${c.id} done in the resumed journal: skipped`);
      rows.push(done);
      continue;
    }
    await waitForDisk();
    await waitForMemory();
    sampleFixtureMemory();
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
    let entry;
    let error = null;
    try {
      entry = await captureInboxTurn(
        client,
        c.request,
        args.caseTimeoutS * 1000,
      );
    } catch (e) {
      error = e;
    }
    if (error) {
      record({
        id: c.id,
        error: error.message,
        policy: isPolicyCase(c),
        unanswerable: isUnanswerableCase(c),
      });
      await resetAfterCase(client, [], knownWorkspaces, baseline, {
        sessionId: "",
        workspaceId: agent.workspaceId,
        items: baselineItems,
      });
      continue;
    }
    const session = { id: entry.sessionId };
    // The conversation the previous case used, if the server continued it.
    const carryOver =
      Boolean(previousSessionId) && session.id === previousSessionId;
    if (carryOver)
      log(`${c.id} continued the previous case's conversation (carry-over)`);
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
    await resetAfterCase(client, tools, knownWorkspaces, baseline, {
      sessionId: session.id,
      workspaceId: agent.workspaceId,
      items: baselineItems,
    });
    previousSessionId = session.id;
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
    const outcome = classifyOutcome(tools, reply, agent.workspaceId, projects);
    const finalEntry = (await client.get("/api/personal-agent/inbox")).find(
      (e) => e.id === entry.id,
    );
    record({
      id: c.id,
      sessionId: session.id,
      inbox: {
        id: entry.id,
        status: finalEntry?.status || "",
        resultStatus: finalEntry?.resultStatus || "",
        resultError: finalEntry?.resultError || "",
      },
      carryOver,
      policy: isPolicyCase(c),
      unanswerable: isUnanswerableCase(c),
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
      questionsInReply: questionsIn(reply),
      blockingAsks: blockingAsksOf(tools, reply, agent.workspaceId).length,
      banned: bannedIn(reply, c.request),
      ...outcome,
    });
  }
  await worker.stop();
  e2eProjects.splice(0, e2eProjects.length, ...projects);
  return rows;
}

// The projects of the run (mention diagnostic), for scoring rows again after the judge.
const e2eProjects = [];

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
      e2eProjects,
      { asks },
    );
    const before = r.decisionByMark || r.decision;
    delete r.workspaceId;
    delete r.mentionedProject;
    delete r.judgedAsks;
    delete r.decisionByMark;
    Object.assign(r, outcome, asks === undefined ? {} : { judgedAsks: asks });
    r.blockingAsks = blockingAsksOf(tools, r.reply, assistantWorkspace, {
      asks,
    });
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
// Free space on the disk the stacks live on, in GB (df's available blocks).
function freeDiskGb() {
  const line = execFileSync("df", ["-Pk", root], { encoding: "utf8" })
    .trim()
    .split("\n")
    .at(-1);
  return Number(line.split(/\s+/)[3]) / 1024 / 1024;
}

// Pauses before the next case while the disk is below the floor, and says so:
// a case started on a full disk fails in ways that look like the model's.
async function waitForDisk(minGb = 4.5) {
  for (;;) {
    const free = freeDiskGb();
    if (free >= minGb) return;
    log(
      `free disk ${free.toFixed(2)} GB < ${minGb} GB: pausing before the next case`,
    );
    await sleep(60_000);
  }
}

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
// from the copy (their folders stay under the worker's scratch HOME), what it
// remembered or changed in the rules is undone, its list items are removed,
// and its conversation is archived so the next inbox message starts a new one.
// Not reset: the assistant's own files (no delete endpoint; see the report's
// carry-over list).
async function resetAfterCase(
  client,
  tools,
  knownWorkspaces,
  baseline,
  { sessionId, workspaceId, items },
) {
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
  await client
    .request("DELETE", "/api/personal-agent/memory")
    .catch((e) => log(`could not reset memory: ${e.message}`));
  if (baseline)
    await client
      .request("PUT", "/api/personal-agent/settings", { body: baseline })
      .catch((e) => log(`could not reset rules: ${e.message}`));
  await archiveConversation(client, workspaceId, sessionId).catch((e) =>
    log(`could not archive ${sessionId}: ${e.message}`),
  );
  if (items)
    for (const id of await itemIds(client).catch(() => new Set()))
      if (!items.has(id))
        await client
          .request(
            "DELETE",
            `/api/personal-agent/items/${encodeURIComponent(id)}`,
          )
          .catch((e) => log(`could not delete item ${id}: ${e.message}`));
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

function scoreE2E(allRows, cases, names) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  // Policy cases run and are reported on their own; no routing metric counts
  // them. Unanswerable-as-redacted cases count in every metric except clear
  // top-1 and routing accuracy (below).
  const rows = allRows.filter((r) => !r.policy);
  const policyRows = allRows.filter((r) => r.policy);
  const unanswerableRows = allRows.filter((r) => r.unanswerable && !r.policy);
  const ok = rows.filter((r) => !r.error && r.status !== "failed");
  // Asked, routed right, routed wrong: a project right when it is the gold or
  // an acceptable one.
  const unanswerableOk = unanswerableRows.filter(
    (r) => !r.error && r.status !== "failed",
  );
  const unanswerableAsked = unanswerableOk.filter((r) => r.decision === "ask");
  const unanswerableRight = unanswerableOk.filter(
    (r) =>
      r.decision === "project" && accepted(byId.get(r.id)).has(r.workspaceId),
  );
  const unanswerableWrong = unanswerableOk.filter(
    (r) =>
      r.decision === "project" && !accepted(byId.get(r.id)).has(r.workspaceId),
  );
  const unanswerable = {
    cases: unanswerableRows.length,
    failed: unanswerableRows.length - unanswerableOk.length,
    asked: unanswerableAsked.length,
    routedRight: unanswerableRight.length,
    routedWrong: unanswerableWrong.length,
    other:
      unanswerableOk.length -
      unanswerableAsked.length -
      unanswerableRight.length -
      unanswerableWrong.length,
  };
  const right = (r) => {
    const c = byId.get(r.id);
    const allowed = accepted(c);
    if (r.decision === "project") return allowed.has(r.workspaceId);
    return allowed.has(r.decision);
  };
  // The headline excludes unanswerable-as-redacted cases; the rest keeps them.
  const headline = ok.filter((r) => !r.unanswerable);
  const clear = headline.filter((r) => goldKind(byId.get(r.id)) === "project");
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
    policyCases: policyRows.length,
    // A case that continued the previous case's conversation: state leaked.
    carryOverCases: allRows.filter((r) => r.carryOver).length,
    failed: rows.length - ok.length,
    timedOut: rows.filter((r) => r.timedOut).length,
    routingAccuracy: ratio(headline.filter(right).length, headline.length),
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
      ? ok.reduce((s, r) => s + (r.questionsInReply ?? r.questions), 0) /
        ok.length
      : null,
    blockingAsksPerRequest: ok.length
      ? ok.reduce((s, r) => s + (r.blockingAsks ?? 0), 0) / ok.length
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
    mentionedProjectRows: ok.filter((r) => r.mentionedProject).length,
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
  // Reported, not scored: the reply and the decision, for the policy reading.
  const policy = policyRows.map((r) => ({
    id: r.id,
    status: r.status,
    decision: r.decision,
    workspaceId: r.workspaceId || "",
    timedOut: Boolean(r.timedOut),
    error: r.error || "",
    sessionId: r.sessionId || "",
  }));
  return { metrics, checks, misses, policy, unanswerable };
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
        '- asks: the work cannot go on without input from the person: a choice among real options (which one of several things, including a numbered list to pick from), or missing information (a link, name, file or text). With or without a question mark. Not asking: an offer to do optional extra work after the work is done or blocked ("要我…吗？"); a yes/no on an optional adjacent setting after the requested change is saved; a question about a side term after the main answer is given; a system permission or Feishu confirmation the work waits on (a gate, not a question). false when it answers, reports, or says it will do the work. Saying a computer is offline and the work starts once it is back is not asking.',
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

// --repeat: the same cases run N times in one stack. Agreement is how often
// the runs gave the same decision (each case, and each pair of runs); the
// majority is per case. Intervals are pooled over cases: a case is one unit
// however many runs it had, so a 95% percentile bootstrap resamples cases
// (seeded, so the interval reproduces).
const routedRight = (r, c) =>
  accepted(c).has(r.decision === "project" ? r.workspaceId : r.decision);
const REPEAT_METRICS = {
  routingAccuracy: [(r) => !r.unanswerable, (r, c) => routedRight(r, c)],
  clearTop1: [
    (r, c) => !r.unanswerable && goldKind(c) === "project",
    (r, c) => routedRight(r, c),
  ],
  wrongDispatchRate: [
    (r) => r.decision === "project" || r.decision === "new",
    (r, c) =>
      !routedRight(r, c) &&
      !(
        c.gold.target === "ask" &&
        r.decision === "project" &&
        (c.gold.options || []).includes(r.workspaceId)
      ),
  ],
  askOnAmbiguous: [
    (r, c) => c.gold.target === "ask",
    (r) => r.decision === "ask",
  ],
  newPrecision: [(r) => r.decision === "new", (r, c) => accepted(c).has("new")],
  newRecall: [(r, c) => c.gold.target === "new", (r) => r.decision === "new"],
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// hits/trials per case, pooled: the point estimate and a 95% percentile
// bootstrap over cases.
function bootstrapRatio(trials, hits, draws = 2000) {
  const total = trials.reduce((s, x) => s + x, 0);
  if (!total) return { point: null, low: null, high: null, trials: 0 };
  const random = mulberry32(20261119);
  const n = trials.length;
  const ratios = [];
  for (let d = 0; d < draws; d++) {
    let t = 0;
    let h = 0;
    for (let i = 0; i < n; i++) {
      const k = Math.floor(random() * n);
      t += trials[k];
      h += hits[k];
    }
    if (t) ratios.push(h / t);
  }
  ratios.sort((a, b) => a - b);
  const at = (p) =>
    ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))];
  return {
    point: round(hits.reduce((s, x) => s + x, 0) / total, 4),
    low: round(at(0.025), 4),
    high: round(at(0.975), 4),
    trials: total,
  };
}

function repeatSummary(runs, cases, names) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const usable = (r) => !r.policy && !r.error && r.status !== "failed";
  const label = (r) =>
    r.decision === "project" || r.decision === "new"
      ? `${r.decision}:${r.workspaceId}`
      : r.decision;
  const perCase = new Map();
  for (const rows of runs)
    for (const r of rows.filter(usable)) {
      if (!perCase.has(r.id)) perCase.set(r.id, []);
      perCase.get(r.id).push(r);
    }
  let pairs = 0;
  let agreeing = 0;
  let unanimous = 0;
  let multiRunCases = 0;
  const majorityTrials = [];
  const majorityHits = [];
  for (const [id, list] of perCase) {
    if (list.length < 2) continue;
    multiRunCases++;
    const counts = new Map();
    for (const r of list) counts.set(label(r), (counts.get(label(r)) || 0) + 1);
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        pairs++;
        if (label(list[i]) === label(list[j])) agreeing++;
      }
    if (counts.size === 1) unanimous++;
    const ranked = [...counts].sort((a, b) => b[1] - a[1]);
    const c = byId.get(id);
    if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) continue;
    if (c.unanswerable) continue;
    const top = list.find((r) => label(r) === ranked[0][0]);
    majorityTrials.push(1);
    majorityHits.push(routedRight(top, c) ? 1 : 0);
  }
  const intervals = {};
  for (const [name, [eligible, success]] of Object.entries(REPEAT_METRICS)) {
    const trials = [];
    const hits = [];
    for (const list of perCase.values()) {
      let t = 0;
      let h = 0;
      for (const r of list) {
        const c = byId.get(r.id);
        if (!eligible(r, c)) continue;
        t++;
        if (success(r, c)) h++;
      }
      trials.push(t);
      hits.push(h);
    }
    intervals[name] = bootstrapRatio(trials, hits);
  }
  intervals.routingAccuracyMajority = {
    ...bootstrapRatio(majorityTrials, majorityHits),
    note: "one majority per case, unanswerable and tied cases left out",
  };
  return {
    runs: runs.length,
    rowsPerRun: runs.map((rows) => rows.length),
    agreement: {
      cases: multiRunCases,
      pairwise: pairs ? round(agreeing / pairs, 4) : null,
      unanimousCases: unanimous,
      unanimous: multiRunCases ? round(unanimous / multiRunCases, 4) : null,
    },
    perRun: runs.map((rows) => {
      const m = scoreE2E(rows, cases, names).metrics;
      return {
        routingAccuracy: m.routingAccuracy,
        clearTop1: m.clearTop1,
        wrongDispatchRate: m.wrongDispatchRate,
        askOnAmbiguous: m.askOnAmbiguous,
        newPrecision: m.newPrecision,
        newRecall: m.newRecall,
        bannedTermReplies: m.bannedTermReplies,
      };
    }),
    intervals,
    intervalNote:
      "pooled over all runs; 95% percentile bootstrap over cases (2000 draws, seed 20261119)",
  };
}

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
    if (r.repeats) {
      const { agreement: a, intervals: iv } = r.repeats;
      lines.push(
        `  repeats: ${r.repeats.runs} runs; agreement pairwise ${fmt(a.pairwise, true)}, unanimous cases ${a.unanimousCases}/${a.cases} (${fmt(a.unanimous, true)})`,
      );
      for (const [k, v] of Object.entries(iv))
        lines.push(
          `  ${`${k} (over cases)`.padEnd(24)} ${fmt(v.point, true)} [${fmt(v.low, true)}, ${fmt(v.high, true)}] n=${v.trials}`,
        );
    }
    if (r.misses?.length) {
      lines.push(`  misses (${r.misses.length}):`);
      for (const m of r.misses.slice(0, 25))
        lines.push(
          `    ${m.id}  gold ${m.gold}  got ${Array.isArray(m.got) ? m.got.join(" | ") : m.got}  «${m.request.replace(/\n/g, " ")}»`,
        );
    }
    if (r.policy?.length) {
      lines.push(
        `  policy (run, not in routing metrics): ${r.policy.length} case(s)`,
      );
      for (const p of r.policy)
        lines.push(
          `    ${p.id}  decision ${p.decision || "-"}  status ${p.status || "-"}${p.error ? `  error ${p.error}` : ""}`,
        );
    }
    if (r.unanswerable) {
      const u = r.unanswerable;
      lines.push(
        `  unanswerable-as-redacted (run, not in routing metrics): ${u.cases} case(s): asked ${u.asked}, routed right ${u.routedRight}, routed wrong ${u.routedWrong}, other ${u.other}, failed ${u.failed}`,
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
    // Repetitions share the stack; each is the whole sample. The cost cap
    // covers all of them: a repetition starts only if the last one's cost
    // still fits under it.
    const runs = [];
    let spent = 0;
    for (let k = 1; k <= args.repeat; k++) {
      const lastCost = runs.length
        ? runs.at(-1).reduce((t, r) => t + (r.usage?.costUsd || 0), 0)
        : 0;
      if (k > 1 && spent + lastCost > args.maxCostUsd) {
        log(
          `stopping before repetition ${k}: $${(spent + lastCost).toFixed(2)} would pass $${args.maxCostUsd}`,
        );
        break;
      }
      log(`repetition ${k} of ${args.repeat}`);
      const rows = await e2eRun(
        client,
        worker,
        agent,
        deviceId,
        sample,
        args,
        names,
        k,
      );
      for (const r of rows) r.repeat = k;
      runs.push(rows);
      spent += rows.reduce((t, r) => t + (r.usage?.costUsd || 0), 0);
    }
    const rows = runs.flat();
    report.e2e = {
      ...scoreE2E(rows, cases, names),
      rows,
      summaries,
      assistantWorkspace: agent.workspaceId,
      projects: e2eProjects,
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
    if (runs.length > 1) report.e2e.repeats = repeatSummary(runs, cases, names);
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
// projects come from the report or, for older reports (offline ones only), from the eval
// set's index (the fixture's computers are the index's).
function rescoreReport(file) {
  const path = resolve(file);
  const report = JSON.parse(readFileSync(path, "utf8"));
  const { cases, index, names } = loadEvalSet(
    resolve(homedir(), ".foundry/pa-eval/set"),
  );
  const projects =
    report.e2e.projects ||
    report.e2e.offline ||
    index.projects.map((p) => ({
      id: p.workspaceId,
      name: p.name,
      device: p.computer,
      ref: p.ref,
    }));
  e2eProjects.splice(0, e2eProjects.length, ...projects);
  const assistant = report.e2e.assistantWorkspace || "";
  rescoreRows(report.e2e.rows, assistant, report.judge?.verdicts || []);
  const scored = scoreE2E(report.e2e.rows, cases, names);
  Object.assign(report.e2e, scored, {
    projects,
    assistantWorkspace: assistant,
  });
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
  const { cases, index, names } = loadEvalSet(args.evalDir);
  const stack = new Stack(args.instance, args.stackDir);
  const worker = new Worker(stack, args.workerHome, "worker", args.provider);
  const report = {
    startedAt: new Date().toISOString(),
    instance: args.instance,
    cases: cases.length,
    checks: [],
  };
  args.journal =
    args.resume ||
    (args.out
      ? `${args.out}.rows.jsonl`
      : resolve(
          tmpdir(),
          "pa-eval-reports",
          `rows-${report.startedAt.replace(/[:.]/g, "-")}.jsonl`,
        ));
  mkdirSync(resolve(args.journal, ".."), { recursive: true, mode: 0o700 });
  if (args.resume) {
    if (!existsSync(args.resume))
      throw new SetupError(`--resume: no journal at ${args.resume}`);
    args.resumed = readJournal(args.resume);
    log(
      `resuming from ${args.resume}: ${args.resumed.size} case(s) already done`,
    );
  }
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
      await startFixtureWorkers(client, stack, index);
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
  for (const fixture of fixtureWorkers) await fixture.stop();
  if (fixtureWorkers.length)
    report.fixtures = {
      computers: fixtureWorkers.length,
      memory: fixtureMemory,
    };
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
