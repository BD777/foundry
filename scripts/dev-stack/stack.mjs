// Stack primitives: registry, launchd service definitions, build and lifecycle.
// One stack is one worktree with its own server, worker, web, ports, database
// and private state root. The default stack keeps the plain `dev.foundry.*`
// labels and `~/.foundry`; named stacks live under `~/.foundry-stacks/<name>`.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

export const stackParent = resolve(homedir(), ".foundry-stacks");
export const registryPath = resolve(stackParent, "stacks.json");
export const agentDir = resolve(homedir(), "Library/LaunchAgents");
export const deviceProfilesPath = resolve(
  homedir(),
  ".foundry/agent-profiles.local.json",
);
export const defaultStack = {
  name: "main",
  portBase: 31000,
  stateRoot: resolve(homedir(), ".foundry"),
};
export const services = ["server", "web", "worker"];
export const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");

export const wait = (ms) => new Promise((done) => setTimeout(done, ms));
export const shellQuote = (value) =>
  `'${String(value).replaceAll("'", "'\\''")}'`;
export const ports = (portBase) => ({
  server: portBase + 982,
  web: portBase + 983,
});
export const label = (name, service) =>
  name === defaultStack.name
    ? `dev.foundry.${service}`
    : `dev.foundry.${name}.${service}`;
export const target = (name, service) =>
  `gui/${process.getuid()}/${label(name, service)}`;
export const plistPath = (name, service) =>
  resolve(agentDir, `${label(name, service)}.plist`);

/**
 * Optional per-stack credential file, mode 0600 inside the stack's private
 * state root. The worker inherits everything it exports, so a stack can drive
 * an agent profile whose secret is not in the device-wide
 * `~/.foundry/agent-profiles.local.json`. The plist only names the path.
 */
export const providerEnvPath = (stack) =>
  resolve(stack.stateRoot, "provider-env");

export function readJSON(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** `KEY=value` lines of a provider-env file, comments and blanks ignored. */
export function readProviderEnv(stack) {
  const path = providerEnvPath(stack);
  if (!existsSync(path)) return undefined;
  const entries = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.replace(/^export\s+/, ""))
    .map((line) => line.split("="))
    .filter(([key, ...rest]) => key && rest.length > 0)
    .map(([key, ...rest]) => [
      key.trim(),
      rest
        .join("=")
        .trim()
        .replace(/^["']|["']$/g, ""),
    ]);
  return Object.fromEntries(entries);
}

export function registry() {
  return readJSON(registryPath) ?? [];
}

export function saveRegistry(stacks) {
  mkdirSync(stackParent, { recursive: true, mode: 0o700 });
  writeFileSync(registryPath, `${JSON.stringify(stacks, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** The default stack predates this script, so it is read back from its plist. */
function mainStack() {
  const plist = plistPath(defaultStack.name, "server");
  if (!existsSync(plist)) return undefined;
  const text = readFileSync(plist, "utf8");
  const program =
    /<string>([^<]*apps\/server\/\.tmp\/foundry-server)<\/string>/.exec(text);
  const port = /<key>PORT<\/key>\s*<string>(\d+)<\/string>/.exec(text);
  return {
    ...defaultStack,
    worktree: program ? resolve(program[1], "../../../..") : "(unknown)",
    portBase: port ? Number(port[1]) - 982 : defaultStack.portBase,
  };
}

export function knownStacks() {
  const main = mainStack();
  return [...(main ? [main] : []), ...registry()];
}

export function stackByName(name) {
  const stack = knownStacks().find((entry) => entry.name === name);
  if (!stack)
    throw new Error(
      `unknown stack ${name}: ${knownStacks()
        .map((entry) => entry.name)
        .join(", ")} exist`,
    );
  return stack;
}

export function portFree(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port })
      .on("connect", () => {
        socket.destroy();
        done(false);
      })
      .on("error", () => done(true));
    setTimeout(() => {
      socket.destroy();
      done(true);
    }, 500);
  });
}

export async function reachable(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) return true;
    } catch {
      /* not listening yet */
    }
    await wait(500);
  }
  return false;
}

/**
 * Stack tooling calls the API as the stack's own worker device: its
 * credential acts as the stack admin account, so no password is needed here.
 * Stacks are resolved by server port, the one thing callers pass.
 */
function deviceHeaders(port) {
  const stack = knownStacks().find(
    (entry) => ports(entry.portBase).server === port,
  );
  const credential = stack
    ? readJSON(resolve(stack.stateRoot, "daemon-config.json"))?.deviceCredential
    : undefined;
  return credential ? { "X-Foundry-Device-Credential": credential } : {};
}

export async function getJSON(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: deviceHeaders(port),
  });
  if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`);
  return response.json();
}

export async function postJSON(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...deviceHeaders(port) },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(
      `POST ${path} answered ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  return response.json();
}

const escapeXML = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export function plistXML(entries) {
  const value = (item) =>
    Array.isArray(item)
      ? `<array>\n${item.map((entry) => `      <string>${escapeXML(entry)}</string>`).join("\n")}\n    </array>`
      : typeof item === "object"
        ? `<dict>\n${Object.entries(item)
            .map(
              ([key, entry]) =>
                `      <key>${escapeXML(key)}</key>\n      <string>${escapeXML(entry)}</string>`,
            )
            .join("\n")}\n    </dict>`
        : typeof item === "boolean"
          ? `<${item}/>`
          : `<string>${escapeXML(String(item))}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${Object.entries(entries)
  .map(([key, item]) => `    <key>${escapeXML(key)}</key>\n    ${value(item)}`)
  .join("\n")}
</dict>
</plist>
`;
}

/**
 * `claude` and other user-installed CLIs live in `~/.local/bin`, which launchd
 * does not add. Without it every agent session fails within milliseconds with
 * "Claude Code CLI is not available on PATH", which reads like an auth problem.
 */
export const servicePATH = () =>
  [
    resolve(process.execPath, ".."),
    resolve(homedir(), ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");

function workerArguments(stack, serverPort) {
  const command = [
    process.execPath,
    resolve(stack.worktree, "packages/worker/dist/cli.js"),
    "daemon",
    "--server",
    `http://127.0.0.1:${serverPort}`,
    "--workspace",
    stack.worktree,
  ];
  const providerEnv = providerEnvPath(stack);
  if (!existsSync(providerEnv)) return command;
  return [
    "/bin/bash",
    "-c",
    `set -a; . ${shellQuote(providerEnv)}; set +a; exec ${command.map(shellQuote).join(" ")}`,
  ];
}

export function serviceDefinitions(stack) {
  const { server, web } = ports(stack.portBase);
  const logDir = resolve(stack.stateRoot, "logs");
  const pnpm = execFileSync("which", ["pnpm"], { encoding: "utf8" }).trim();
  const shared = { HOME: homedir(), PATH: servicePATH() };
  return {
    server: {
      ProgramArguments: [
        resolve(stack.worktree, "apps/server/.tmp/foundry-server"),
      ],
      WorkingDirectory: resolve(stack.worktree, "apps/server"),
      EnvironmentVariables: {
        ...shared,
        PORT: String(server),
        FOUNDRY_WEB_ORIGIN: `http://127.0.0.1:${web}`,
      },
      StandardOutPath: resolve(logDir, "server.log"),
      StandardErrorPath: resolve(logDir, "server.err.log"),
    },
    web: {
      ProgramArguments: [
        "/bin/bash",
        "-c",
        `cd ${stack.worktree} && exec ${pnpm} --filter @foundry/web dev --port ${web} --strictPort`,
      ],
      WorkingDirectory: stack.worktree,
      EnvironmentVariables: {
        ...shared,
        VITE_API_BASE_URL: `http://127.0.0.1:${server}`,
      },
      StandardOutPath: resolve(logDir, "web.log"),
      StandardErrorPath: resolve(logDir, "web.err.log"),
    },
    worker: {
      ProgramArguments: workerArguments(stack, server),
      WorkingDirectory: stack.worktree,
      EnvironmentVariables: {
        ...shared,
        ...(stack.name === defaultStack.name
          ? {}
          : { FOUNDRY_STACK: stack.name }),
      },
      StandardOutPath: resolve(logDir, "daemon.out.log"),
      StandardErrorPath: resolve(logDir, "daemon.err.log"),
    },
  };
}

export const generatedPlist = (stack, service) =>
  plistXML({
    Label: label(stack.name, service),
    RunAtLoad: true,
    KeepAlive: true,
    ...serviceDefinitions(stack)[service],
  });

export function writePlists(stack) {
  mkdirSync(agentDir, { recursive: true });
  for (const service of services)
    writeFileSync(
      plistPath(stack.name, service),
      generatedPlist(stack, service),
      { mode: 0o644 },
    );
}

export function launchctl(args, { check = false } = {}) {
  const result = spawnSync("launchctl", args, { encoding: "utf8" });
  if (check && result.status !== 0)
    throw new Error(
      `launchctl ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  return result;
}

/** What launchd knows about one service right now. */
export function serviceState(name, service) {
  const result = launchctl(["print", target(name, service)]);
  if (result.status !== 0) return { loaded: false };
  const field = (pattern) => pattern.exec(result.stdout || "")?.[1];
  return {
    loaded: true,
    state: field(/^\s*state = (\S+)/m),
    pid: field(/^\s*pid = (\d+)/m),
    runs: Number(field(/^\s*runs = (\d+)/m) ?? 0),
    lastExit: field(/last exit (?:code|status) = (\S+)/),
    lastSignal: field(/last terminating signal = (.+)/)?.trim(),
  };
}

export function logTail(path, lines = 12) {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").split("\n").slice(-lines).join("\n");
}

/** Newest mtime under a directory, for "is the build stale" questions. */
export function newestMtime(dir, extensions) {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    if (extensions && !extensions.some((ext) => entry.name.endsWith(ext)))
      continue;
    const path = resolve(entry.parentPath ?? entry.path, entry.name);
    newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

export const fileMtime = (path) =>
  existsSync(path) ? statSync(path).mtimeMs : 0;

export function build(stack, { install = true } = {}) {
  const run = (command, args, cwd) => {
    const result = spawnSync(command, args, { cwd, stdio: "inherit" });
    if (result.status !== 0)
      throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
  };
  if (install && !existsSync(resolve(stack.worktree, "node_modules")))
    run("pnpm", ["install"], stack.worktree);
  run("pnpm", ["--filter", "@foundry/protocol", "build"], stack.worktree);
  run("pnpm", ["--filter", "@foundry/worker", "build"], stack.worktree);
  run(
    "go",
    ["build", "-o", ".tmp/foundry-server", "./cmd/foundry-server"],
    resolve(stack.worktree, "apps/server"),
  );
}

/**
 * A worker built before the private state root existed would fall back to
 * `~/.foundry` and fight the default stack over device identity, the workspace
 * registry and issue environments. Refuse instead of corrupting both stacks.
 */
export function assertIsolatable(stack) {
  const built = resolve(stack.worktree, "packages/worker/dist/state-root.js");
  if (!existsSync(built))
    throw new Error(
      `${stack.worktree} has no built packages/worker/dist/state-root.js: this worktree predates per-stack state roots, so its worker would write into ~/.foundry. Update the worktree and rebuild.`,
    );
}

/**
 * The daemon serves one workspace directory. `.foundry/workspace.json` is
 * machine-local, so a fresh worktree has none and the daemon would log
 * "No Foundry workspace found" on every reconnect.
 */
export function initWorkspace(stack, { force = false } = {}) {
  const identity = resolve(stack.worktree, ".foundry/workspace.json");
  if (!force && existsSync(identity)) return;
  const result = spawnSync(
    process.execPath,
    [
      resolve(stack.worktree, "packages/worker/dist/cli.js"),
      "init",
      stack.worktree,
    ],
    {
      cwd: stack.worktree,
      env: { ...process.env, FOUNDRY_STACK: stack.name },
      stdio: "inherit",
    },
  );
  if (result.status !== 0)
    throw new Error(`could not initialize the workspace in ${stack.worktree}`);
}

const stackAdmin = "stack-admin";

/**
 * Pairs the stack's worker with its own server once: creates the stack admin
 * account (password kept owner-only in the state root for web sign-in) and
 * redeems a one-time token issued by the server CLI. Idempotent.
 */
export function ensureStackPaired(stack) {
  const config = readJSON(resolve(stack.stateRoot, "daemon-config.json"));
  if (config?.deviceCredential) return;
  const serverDir = resolve(stack.worktree, "apps/server");
  const serverBinary = resolve(serverDir, ".tmp/foundry-server");
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, {
      cwd: serverDir,
      encoding: "utf8",
      ...options,
    });
    if (result.status !== 0)
      throw new Error(
        `${[command, ...args].join(" ")} failed: ${result.stderr || result.stdout}`,
      );
    return result.stdout;
  };
  const users = run(serverBinary, ["users", "list"]);
  if (!users.split("\n").some((line) => line.startsWith(`${stackAdmin} `))) {
    const created = run(serverBinary, [
      "users",
      "create",
      "--username",
      stackAdmin,
      "--role",
      "admin",
    ]);
    const password = /password: (\S+)/.exec(created)?.[1];
    if (password)
      writeFileSync(
        resolve(stack.stateRoot, "admin-password"),
        `${stackAdmin} ${password}\n`,
        { mode: 0o600 },
      );
  }
  const token = run(serverBinary, [
    "devices",
    "pairing-token",
    "--username",
    stackAdmin,
  ]).trim();
  const { server } = ports(stack.portBase);
  run(
    process.execPath,
    [
      resolve(stack.worktree, "packages/worker/dist/cli.js"),
      "pair",
      "--server",
      `http://127.0.0.1:${server}`,
      "--workspace",
      stack.worktree,
      "--token",
      token,
    ],
    {
      cwd: stack.worktree,
      env: {
        ...process.env,
        ...(stack.name === defaultStack.name
          ? {}
          : { FOUNDRY_STACK: stack.name }),
      },
    },
  );
}

/**
 * `launchctl bootout` returns before launchd releases the label; bootstrapping
 * inside that window fails with "Bootstrap failed: 5: Input/output error".
 */
export async function bootout(name, service) {
  launchctl(["bootout", target(name, service)]);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!serviceState(name, service).loaded) return;
    await wait(100);
  }
  throw new Error(`${label(name, service)} did not stop`);
}

export async function start(name) {
  const stack = stackByName(name);
  if (stack.name !== defaultStack.name) {
    assertIsolatable(stack);
    // Regenerate from the current generator so PATH and credential fixes reach
    // stacks created before them. The default stack is hand-managed.
    writePlists(stack);
  }
  for (const service of services) {
    await bootout(name, service);
    launchctl(
      ["bootstrap", `gui/${process.getuid()}`, plistPath(name, service)],
      { check: true },
    );
  }
  const { server, web } = ports(stack.portBase);
  const serverReady = await reachable(
    `http://127.0.0.1:${server}/healthz`,
    30000,
  );
  // The worker service waits unpaired until this runs; launchd restarts it.
  if (serverReady) ensureStackPaired(stack);
  const ready = {
    server: serverReady,
    web: await reachable(`http://127.0.0.1:${web}/`, 60000),
  };
  for (const [service, ok] of Object.entries(ready))
    if (!ok)
      throw new Error(
        `${service} did not answer; see ${resolve(stack.stateRoot, "logs")}`,
      );
  return ready;
}

export function stop(name) {
  stackByName(name);
  for (const service of services) launchctl(["bootout", target(name, service)]);
}

export function status() {
  for (const stack of knownStacks()) {
    const { server, web } = ports(stack.portBase);
    const running = services.map((service) => {
      const state = serviceState(stack.name, service);
      return `${service}${state.pid ? `:${state.pid}` : ":-"}`;
    });
    console.log(
      `${stack.name.padEnd(12)} web ${web}  server ${server}  ${running.join(" ")}  ${stack.worktree}`,
    );
  }
}

export function remove(name, options) {
  const stack = stackByName(name);
  if (name === defaultStack.name)
    throw new Error("the default stack is not managed by this script");
  stop(name);
  for (const service of services)
    rmSync(plistPath(name, service), { force: true });
  saveRegistry(registry().filter((entry) => entry.name !== name));
  if (options.purgeState)
    rmSync(stack.stateRoot, { recursive: true, force: true });
  console.log(
    `stack ${name} removed${options.purgeState ? " with its state" : `; state kept at ${stack.stateRoot}`}`,
  );
}
