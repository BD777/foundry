// Diagnosis and repair for one stack.
//
// Every failure this project has actually hit — stale builds, a worktree that
// predates per-stack state roots, a workspace identity copied from another
// checkout, drifted launch agents, a crash-looping daemon, a CLI that is not on
// the service PATH, a credential that moved out of the device profile file — is
// a named check here with the fix next to it, and most of them can be repaired
// by the tool itself with `--fix`. Exploration belongs in this file, not in the
// next person's terminal history.

import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  build,
  defaultStack,
  deviceProfilesPath,
  fileMtime,
  generatedPlist,
  getJSON,
  initWorkspace,
  knownStacks,
  logTail,
  newestMtime,
  plistPath,
  ports,
  postJSON,
  providerEnvPath,
  readJSON,
  readProviderEnv,
  reachable,
  registry,
  serviceState,
  services,
  servicePATH,
  stackByName,
  start,
  wait,
  writePlists,
} from "./stack.mjs";

const codexAuthPath = resolve(homedir(), ".codex/auth.json");
const readText = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

/** Repairs the tool may run itself, in dependency order. */
const repairs = {
  build: {
    order: 10,
    label: "rebuild protocol, worker and server",
    run: (stack) => build(stack),
  },
  workspace: {
    order: 20,
    label: "re-create the workspace identity",
    run: (stack) => initWorkspace(stack, { force: true }),
  },
  permissions: {
    order: 25,
    label: "restore private file permissions",
    run: (stack) => {
      if (existsSync(stack.stateRoot)) chmodSync(stack.stateRoot, 0o700);
      const providerEnv = providerEnvPath(stack);
      if (existsSync(providerEnv)) chmodSync(providerEnv, 0o600);
    },
  },
  plists: {
    order: 30,
    label: "rewrite the launch agents",
    run: (stack) => writePlists(stack),
  },
  restart: {
    order: 40,
    label: "restart the stack",
    run: (stack) => start(stack.name),
  },
};

/**
 * Resolve an executable the way execvp does. A shell would answer for the
 * shell's environment — which on this machine is not the environment launchd
 * gives the services — so the lookup is done directly against the PATH in
 * question.
 */
function whichIn(command, pathValue) {
  for (const dir of (pathValue ?? "").split(":").filter(Boolean)) {
    const candidate = resolve(dir, command);
    try {
      if (statSync(candidate).mode & 0o111) return candidate;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

const backupsWithSecret = (path, holds) => {
  const dir = dirname(path);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(
      (entry) =>
        entry.startsWith(`${basename(path)}.`) && entry.includes("bak"),
    )
    .map((entry) => resolve(dir, entry))
    .filter((entry) => holds(readJSON(entry)));
};

/**
 * Where a profile's secret could come from on this machine, and which of those
 * places actually holds one. This is the lookup that otherwise costs an agent
 * ten minutes of reading worker source.
 */
function credentialAdvice(profile, stack) {
  const providerEnv = readProviderEnv(stack) ?? {};
  const envNames =
    profile.runtime === "claude"
      ? ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_API_KEY"]
      : ["OPENAI_API_KEY", "CODEX_API_KEY"];
  const exported = envNames.filter((name) => providerEnv[name]?.trim());
  const sources = [];
  if (profile.connectionType === "local_login") {
    const authPath = profile.runtime === "codex" ? codexAuthPath : undefined;
    if (authPath) {
      sources.push(
        existsSync(authPath)
          ? `${authPath} exists but the CLI reports no usable login`
          : `${authPath} is missing: the CLI is logged out`,
      );
      for (const backup of backupsWithSecret(authPath, (data) =>
        Object.values(data ?? {}).some(
          (value) => typeof value === "string" && value.trim(),
        ),
      ))
        sources.push(`${backup} still holds a key`);
    }
    return [
      ...sources,
      `fix: log in with the ${profile.runtime} CLI, or restore one of the backups above`,
    ].join("; ");
  }
  const device = (readJSON(deviceProfilesPath)?.profiles ?? []).find(
    (entry) => entry.id === profile.id,
  );
  sources.push(
    device
      ? device.apiKey?.trim()
        ? `${deviceProfilesPath} has a key (the daemon may need a restart to read it)`
        : `${deviceProfilesPath} has this profile with an empty apiKey`
      : `${deviceProfilesPath} has no entry for ${profile.id}`,
  );
  for (const backup of backupsWithSecret(deviceProfilesPath, (data) =>
    (data?.profiles ?? []).some(
      (entry) => entry.id === profile.id && entry.apiKey?.trim(),
    ),
  ))
    sources.push(`${backup} still holds a key for ${profile.id}`);
  sources.push(
    exported.length > 0
      ? `${providerEnvPath(stack)} exports ${exported.join(", ")}`
      : `${providerEnvPath(stack)} exports none of ${envNames.join(", ")}`,
  );
  return [
    ...sources,
    `fix: put the key in ${deviceProfilesPath}, or write ${envNames[0]}=... into ${providerEnvPath(stack)} (chmod 600) and restart the stack`,
  ].join("; ");
}

/**
 * Known daemon log lines and what they actually mean. These explain a failure,
 * they never decide one: a log keeps its history, so the live checks above are
 * the only authority on the stack as it is right now.
 */
const logSignatures = [
  {
    id: "log:protocol-drift",
    pattern: /unknown websocket message type: (\S+)/,
    meaning: (match) =>
      `daemon and server disagreed about the protocol (${match[1]}): one of them ran an older build — rebuild both`,
  },
  {
    id: "log:no-workspace",
    pattern: /No Foundry workspace found/,
    meaning: () =>
      "the daemon found no workspace identity to serve — re-create it if the live check also fails",
  },
  {
    id: "log:missing-cli",
    pattern: /Claude Code CLI is not available/,
    meaning: () =>
      "a session failed instantly because the CLI was missing from the service PATH",
  },
  {
    id: "log:server-gap",
    pattern: /ECONNREFUSED|fetch failed/,
    meaning: () =>
      "the daemon retried while the server was down (normal around a restart)",
  },
];

function installedPATH(name) {
  const plist = plistPath(name, "worker");
  if (!existsSync(plist)) return undefined;
  const result = spawnSync(
    "plutil",
    ["-extract", "EnvironmentVariables.PATH", "raw", "-o", "-", plist],
    { encoding: "utf8" },
  );
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** When the running process started, so stale log lines can be ignored. */
function processStart(pid) {
  if (!pid) return 0;
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
  });
  const parsed = Date.parse(result.stdout.trim());
  return Number.isNaN(parsed) ? 0 : parsed;
}

const logSince = (path, sinceMs) =>
  fileMtime(path) >= sinceMs ? logTail(path, 40) : "";

export async function diagnose(stack) {
  const checks = [];
  const add = (id, level, text, extra = {}) =>
    checks.push({ id, level, text, ...extra });
  const { name, worktree } = stack;
  const { server, web } = ports(stack.portBase);
  const logs = resolve(stack.stateRoot, "logs");
  // The CLI question is "can the running worker find it", so read the PATH out
  // of the installed launch agent and only fall back to the generator.
  const path = installedPATH(name) ?? servicePATH();

  // --- worktree, toolchain and builds -------------------------------------
  const isWorktree = existsSync(resolve(worktree, "pnpm-workspace.yaml"));
  add(
    "worktree",
    isWorktree ? "ok" : "FAIL",
    isWorktree
      ? `worktree ${worktree}`
      : `${worktree} is not a Foundry worktree`,
    { fix: "point the stack at a checkout that has pnpm-workspace.yaml" },
  );
  if (!isWorktree) return report(checks);
  for (const tool of ["pnpm", "go", "git"]) {
    const found = whichIn(tool, process.env.PATH);
    add(
      `toolchain:${tool}`,
      found ? "ok" : "FAIL",
      `${tool} ${found ?? "is not installed"}`,
      { fix: `install ${tool}; builds cannot run without it` },
    );
  }
  const nodeModules = existsSync(resolve(worktree, "node_modules"));
  add(
    "dependencies",
    nodeModules ? "ok" : "FAIL",
    nodeModules ? "node_modules installed" : "node_modules is missing",
    { repair: "build", fix: `pnpm install in ${worktree}` },
  );
  const artifacts = [
    {
      id: "build:protocol",
      source: resolve(worktree, "packages/protocol/src"),
      output: resolve(worktree, "packages/protocol/dist/evidence-rpc.js"),
      extensions: [".ts"],
    },
    {
      id: "build:worker",
      source: resolve(worktree, "packages/worker/src"),
      output: resolve(worktree, "packages/worker/dist/cli.js"),
      extensions: [".ts"],
    },
    {
      id: "build:server",
      source: resolve(worktree, "apps/server"),
      output: resolve(worktree, "apps/server/.tmp/foundry-server"),
      extensions: [".go"],
    },
  ];
  for (const artifact of artifacts) {
    const built = fileMtime(artifact.output);
    const newest = newestMtime(artifact.source, artifact.extensions);
    add(
      artifact.id,
      built === 0 ? "FAIL" : newest > built ? "warn" : "ok",
      built === 0
        ? `${artifact.output} is missing`
        : newest > built
          ? `${artifact.id.split(":")[1]} build is older than its sources`
          : `${artifact.id.split(":")[1]} build is current`,
      {
        repair: "build",
        fix: `rebuild: node scripts/dev-stack.mjs fix ${name}`,
      },
    );
  }
  const isolatable = existsSync(
    resolve(worktree, "packages/worker/dist/state-root.js"),
  );
  add(
    "isolation",
    isolatable ? "ok" : "FAIL",
    isolatable
      ? "worker honours FOUNDRY_STACK"
      : "this worker predates per-stack state roots and would write into ~/.foundry",
    { repair: "build", fix: "update the worktree and rebuild before starting" },
  );

  // --- identity, permissions, registry, launch agents ---------------------
  const identity = readJSON(resolve(worktree, ".foundry/workspace.json"));
  const identityPath = identity?.path ?? identity?.localPath;
  const identityMatches =
    Boolean(identityPath) && resolve(identityPath) === resolve(worktree);
  add(
    "workspace-identity",
    identityMatches ? "ok" : "FAIL",
    identity
      ? identityMatches
        ? `workspace identity ${identity.id ?? "?"}`
        : `workspace identity points at ${identityPath ?? "nowhere"}, not this worktree`
      : "no .foundry/workspace.json in this worktree",
    {
      repair: "workspace",
      fix: "a copied identity makes this stack act on another checkout; re-create it",
    },
  );
  const stateMode = existsSync(stack.stateRoot)
    ? statSync(stack.stateRoot).mode & 0o777
    : undefined;
  add(
    "state-root",
    stateMode === 0o700 ? "ok" : "FAIL",
    stateMode === undefined
      ? `${stack.stateRoot} is missing`
      : `state root mode ${stateMode.toString(8)}`,
    { repair: "permissions", fix: `chmod 700 ${stack.stateRoot}` },
  );
  const providerEnv = providerEnvPath(stack);
  if (existsSync(providerEnv)) {
    const mode = statSync(providerEnv).mode & 0o777;
    add(
      "provider-env",
      mode === 0o600 ? "ok" : "FAIL",
      `provider-env mode ${mode.toString(8)} (${Object.keys(readProviderEnv(stack) ?? {}).join(", ") || "no variables"})`,
      { repair: "permissions", fix: `chmod 600 ${providerEnv}` },
    );
  }
  if (name !== defaultStack.name) {
    const entry = registry().find((item) => item.name === name);
    add(
      "registry",
      entry ? "ok" : "FAIL",
      entry
        ? `registered with port base ${entry.portBase}`
        : "not in stacks.json",
      { fix: `re-create the stack: node scripts/dev-stack.mjs create ${name}` },
    );
    const clash = knownStacks().find(
      (other) =>
        other.name !== name &&
        (resolve(other.worktree ?? "") === resolve(worktree) ||
          other.portBase === stack.portBase),
    );
    add(
      "uniqueness",
      clash ? "FAIL" : "ok",
      clash
        ? `stack ${clash.name} shares this worktree or port base`
        : "worktree and ports are unique",
      {
        fix: "two stacks on one worktree corrupt each other; remove or move one",
      },
    );
    const drifted = services.filter(
      (service) =>
        readText(plistPath(name, service)) !== generatedPlist(stack, service),
    );
    add(
      "launch-agents",
      drifted.length === 0 ? "ok" : "warn",
      drifted.length === 0
        ? "launch agents match the generator"
        : `launch agents drifted: ${drifted.join(", ")}`,
      {
        repair: "plists",
        fix: "hand-edited or outdated plists; regenerate and restart",
      },
    );
  }

  // --- running services ----------------------------------------------------
  const states = Object.fromEntries(
    services.map((service) => [service, serviceState(name, service)]),
  );
  for (const service of services) {
    const state = states[service];
    add(
      `service:${service}`,
      state.pid ? "ok" : "FAIL",
      state.pid
        ? `${service} pid ${state.pid}`
        : `${service} ${state.loaded ? `loaded but not running (${state.state ?? "?"})` : "is not loaded"}`,
      {
        // A loaded service may still be spawning; an unloaded one never will.
        transient: state.loaded,
        repair: "restart",
        detail: state.pid
          ? undefined
          : logTail(resolve(logs, `${service}.err.log`), 8),
        fix: `restart the stack and read ${logs}`,
      },
    );
  }
  // A service that exits on startup is respawned by KeepAlive forever: its run
  // counter climbs and it may never hold a pid long enough to be seen.
  await wait(1200);
  const looping = services.filter((service) => {
    const now = serviceState(name, service);
    return (
      now.runs > states[service].runs ||
      (now.loaded && !now.pid && now.runs >= 2)
    );
  });
  add(
    "crash-loop",
    looping.length === 0 ? "ok" : "FAIL",
    looping.length === 0
      ? "no service is restarting"
      : `${looping.join(", ")} keeps restarting (launchd KeepAlive)`,
    {
      // Almost always a stale or broken artifact in this project; the rebuild
      // is cheap and the log tail below holds the real reason either way.
      repair: "build",
      detail: looping
        .map((service) =>
          logTail(
            resolve(
              logs,
              service === "worker" ? "daemon.err.log" : `${service}.err.log`,
            ),
            10,
          ),
        )
        .join("\n"),
      fix: "the service exits on startup; the log tail above holds the reason",
    },
  );

  // --- endpoints, daemon and workspace projection --------------------------
  const endpoints = [
    {
      id: "http:server",
      url: `http://127.0.0.1:${server}/healthz`,
      log: "server.err.log",
    },
    { id: "http:web", url: `http://127.0.0.1:${web}/`, log: "web.err.log" },
  ];
  const workerRunning = Boolean(states.worker.pid);
  for (const endpoint of endpoints) {
    const ok = await reachable(endpoint.url, 2000);
    add(
      endpoint.id,
      ok ? "ok" : "FAIL",
      `${endpoint.id.split(":")[1]} ${endpoint.url}`,
      {
        transient: Boolean(states[endpoint.id.split(":")[1]].pid),
        repair: "restart",
        detail: ok ? undefined : logTail(resolve(logs, endpoint.log), 8),
        fix: `read ${resolve(logs, endpoint.log)}`,
      },
    );
  }
  let profiles = [];
  try {
    const workspaces = await getJSON(server, "/api/workspaces");
    const workspace = workspaces.find(
      (entry) => resolve(entry.localPath) === resolve(worktree),
    );
    add(
      "workspace-registered",
      workspace ? "ok" : "FAIL",
      workspace
        ? `workspace ${workspace.name} (${workspace.id})`
        : `no workspace registered for ${worktree}`,
      {
        transient: workerRunning,
        repair: "workspace",
        fix: "the daemon registers the workspace on connect; re-init if it never appears",
      },
    );
    const connected = (await getJSON(server, "/api/devices")).filter(
      (entry) => entry.status === "connected",
    );
    add(
      "daemon",
      connected.length > 0 ? "ok" : "FAIL",
      connected.length > 0
        ? `daemon ${connected.map((entry) => entry.label).join(", ")}`
        : "no daemon is connected",
      {
        transient: workerRunning,
        repair: "restart",
        detail: logTail(resolve(logs, "daemon.err.log"), 8),
        fix: `read ${resolve(logs, "daemon.err.log")}`,
      },
    );
    profiles = await getJSON(server, "/api/agent-profiles");
  } catch (error) {
    add(
      "api",
      "FAIL",
      `control plane query failed: ${String(error instanceof Error ? error.message : error)}`,
      {
        transient: Boolean(states.server.pid),
        repair: "restart",
        fix: `the control plane is not answering; read ${logs}`,
      },
    );
  }

  // --- daemon log signatures ----------------------------------------------
  // Only lines written since the current worker started are evidence about the
  // stack as it runs now; older ones describe a state that was already fixed.
  const tail = logSince(
    resolve(logs, "daemon.err.log"),
    processStart(states.worker.pid),
  );
  for (const signature of logSignatures) {
    const match = signature.pattern.exec(tail);
    if (!match) continue;
    add(signature.id, "warn", signature.meaning(match), {
      detail: `${match[0]} (${resolve(logs, "daemon.err.log")})`,
    });
  }

  // --- providers: credentials and the CLI each one needs -------------------
  const runnable = [];
  for (const profile of profiles) {
    const healthy = profile.status === "healthy";
    const advice = healthy ? undefined : credentialAdvice(profile, stack);
    add(
      `profile:${profile.id}`,
      healthy ? "ok" : "warn",
      `profile ${profile.id} ${profile.status}${profile.statusDetail ? ` — ${profile.statusDetail}` : ""}`,
      {
        transient: workerRunning,
        detail: advice,
        fix: advice ? `${profile.id}: ${advice}` : undefined,
      },
    );
    if (!healthy) continue;
    const cli = profile.runtime === "codex" ? "codex" : "claude";
    const found = whichIn(cli, path);
    add(
      `cli:${cli}`,
      found ? "ok" : "FAIL",
      found
        ? `${cli} CLI ${found}`
        : `${cli} CLI is not on the service PATH, so every ${profile.runtime} session fails instantly`,
      {
        repair: "plists",
        fix: `install ${cli}, or add its directory to servicePATH() in scripts/dev-stack/stack.mjs`,
      },
    );
    if (found) runnable.push(profile.id);
  }
  add(
    "runnable-profiles",
    runnable.length > 0 ? "ok" : "FAIL",
    runnable.length > 0
      ? `${runnable.length} profile(s) can run: ${runnable.join(", ")}`
      : "no profile can run a session",
    {
      transient: workerRunning,
      fix: "configure one credential above; the stack is useless without one",
    },
  );
  return report(checks);
}

function report(checks) {
  const failures = checks.filter((check) => check.level === "FAIL");
  return {
    ready: failures.length === 0,
    checks,
    // Services register, connect and report health a few seconds after launchd
    // starts them, so a report whose only failures are transient is worth
    // re-taking before anyone is told something is broken.
    transientOnly:
      failures.length > 0 && failures.every((check) => check.transient),
  };
}

async function settle(stack, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let current = await diagnose(stack);
  while (!current.ready && current.transientOnly && Date.now() < deadline) {
    await wait(1000);
    current = await diagnose(stack);
  }
  return current;
}

function plan(current) {
  const wanted = new Map();
  for (const check of current.checks)
    if (check.level !== "ok" && check.repair)
      wanted.set(check.repair, repairs[check.repair]);
  const ordered = [...wanted.entries()].sort(
    ([, left], [, right]) => left.order - right.order,
  );
  // Anything repaired below the service layer only reaches the running stack
  // after a restart.
  if (ordered.length > 0 && !wanted.has("restart"))
    ordered.push(["restart", repairs.restart]);
  return ordered;
}

export async function doctor(
  name,
  { fix = false, json = false, timeoutMs = 20000 } = {},
) {
  const stack = stackByName(name);
  let current = await settle(stack, timeoutMs);
  const applied = [];
  const failing = (report) =>
    report.checks
      .filter((check) => check.level === "FAIL")
      .map((check) => check.id)
      .join(",");
  const failed = [];
  for (let round = 0; fix && round < 2; round += 1) {
    const steps = plan(current);
    if (steps.length === 0) break;
    const before = failing(current);
    for (const [id, repair] of steps) {
      if (!json) console.log(`  fix  ${repair.label}`);
      try {
        await repair.run(stack);
        applied.push(id);
      } catch (error) {
        // One repair failing must not hide the rest of the report: a restart
        // that times out is itself a finding, and a later round may fix it.
        failed.push(
          `${id}: ${String(error instanceof Error ? error.message : error)}`,
        );
      }
    }
    current = await settle(stack, timeoutMs);
    // A repair that changed nothing will not change anything on a second run.
    if (failing(current) === before) break;
  }
  for (const failure of failed)
    current.checks.push({
      id: "repair",
      level: "warn",
      text: `repair failed — ${failure}`,
    });
  if (json) {
    console.log(
      JSON.stringify(
        { stack: name, ready: current.ready, applied, checks: current.checks },
        undefined,
        2,
      ),
    );
    return current.ready;
  }
  console.log(
    `doctor ${name}${applied.length > 0 ? ` (applied ${applied.join(", ")})` : ""}`,
  );
  for (const check of current.checks) {
    console.log(`  ${check.level.padEnd(4)} ${check.text}`);
    if (check.level !== "ok" && check.detail)
      for (const line of String(check.detail).split("\n").filter(Boolean))
        console.log(`       | ${line}`);
  }
  const fixes = new Set(
    current.checks
      .filter((check) => check.level !== "ok" && check.fix)
      .map((check) => check.fix),
  );
  for (const hint of fixes) console.log(`  next ${hint}`);
  if (!current.ready && !fix)
    console.log(`  next try: node scripts/dev-stack.mjs fix ${name}`);
  return current.ready;
}

/**
 * Proves the stack can really run an agent: one chat session through server,
 * daemon and provider, asserting the model's own words instead of a 200.
 */
export async function smoke(name) {
  const stack = stackByName(name);
  const { server } = ports(stack.portBase);
  const workspaces = await getJSON(server, "/api/workspaces");
  const workspace = workspaces.find(
    (entry) => resolve(entry.localPath) === resolve(stack.worktree),
  );
  if (!workspace)
    throw new Error(`stack ${name} has no workspace for ${stack.worktree}`);
  const agents = await getJSON(
    server,
    `/api/agents?workspaceId=${workspace.id}`,
  );
  const agent = agents.find((entry) => entry.status === "healthy");
  if (!agent)
    throw new Error(
      `stack ${name} has no healthy agent; run: node scripts/dev-stack.mjs doctor ${name}`,
    );
  const marker = `FOUNDRY-${name.toUpperCase()}-OK`;
  console.log(`smoke ${name} through ${agent.profileLabel ?? agent.provider}`);
  const created = await postJSON(server, "/api/agent-sessions", {
    workspaceId: workspace.id,
    agentId: agent.id,
    provider: agent.provider,
    profileId: agent.profileId,
    prompt: `Reply with exactly ${marker} and nothing else.`,
    source: "chat",
  });
  const deadline = Date.now() + 240000;
  let session = created;
  while (session.status !== "completed" && session.status !== "failed") {
    if (Date.now() > deadline)
      throw new Error(`session ${created.id} never finished`);
    await wait(2000);
    session = await getJSON(server, `/api/agent-sessions/${created.id}`);
  }
  if (session.status === "failed")
    throw new Error(
      `session ${created.id} failed: ${session.error ?? "no reason recorded"}`,
    );
  const reply = await sessionReply(stack, server, created.id);
  if (!reply.includes(marker))
    throw new Error(
      `session ${created.id} answered without ${marker}: ${reply.slice(0, 200)}`,
    );
  console.log(`  ok   ${agent.provider} answered ${marker}`);
}

async function sessionReply(stack, port, sessionID) {
  const resultPath = resolve(
    stack.worktree,
    ".foundry/sessions",
    sessionID,
    "result.md",
  );
  if (existsSync(resultPath)) return readText(resultPath);
  const threads = await getJSON(
    port,
    `/api/agent-session-threads/${sessionID}`,
  );
  return threads
    .flatMap((thread) => thread.events ?? [])
    .map((event) => event.detail ?? "")
    .join("\n");
}
