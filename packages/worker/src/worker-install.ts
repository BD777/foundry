/**
 * Installing the worker from its npm package, the one-command path:
 *
 *   npx -y <package>@latest install --server <url> --token <pairing-token>
 *
 * npx runs the package from a temporary cache, so `install` first installs
 * the package into a stable runtime directory (<state root>/runtime/<version>,
 * with `current` pointing at the one in use) and the login service runs the
 * worker from there. `update` installs a newer version next to it, switches
 * `current` and restarts the service; `uninstall` removes the service.
 *
 * A server that serves its own worker packages (`/api/worker/release`, e.g. a
 * development build) is followed instead of npm: `install` and `update` take
 * that server's packages, and its bootstrap command runs them through npx:
 *
 *   npx -y --package=<server>/api/worker/packages/<protocol>.tgz \
 *     --package=<server>/api/worker/packages/<worker>.tgz foundry-worker install …
 *
 * A machine (per stack) holds one worker: `install` on a machine whose worker
 * is already paired and installed changes nothing.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerRelease } from "@bd777/foundry-protocol";
import { readDaemonConfig } from "./config.js";
import { setup } from "./daemon-connection.js";
import { removeWorkerApp } from "./mac-worker-app.js";
import {
  reinstallService,
  serviceInstalled,
  status,
  stopDaemonProcess,
  uninstallService,
} from "./service.js";
import {
  defaultStateRoot,
  foundryStatePath,
  foundryStateRoot,
  stackStateParent,
} from "./state-root.js";
import { releaseSelfUpdateLock } from "./self-update-lock.js";
import { optionEnabled, optionValue } from "./utils.js";
import {
  homeRelative,
  ownPackage,
  type PackageIdentity,
  runtimeRoot,
  workerShimPath,
} from "./worker-identity.js";

export { ownPackage, runtimeRoot, workerShimPath };
export type { PackageIdentity };

/** The worker CLI of the runtime in use; the service starts this path. */
export function currentRuntimeCli(name: string): string {
  return join(runtimeRoot(), "current", "node_modules", name, "dist", "cli.js");
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Writes this machine's `foundry-worker` command: it runs the installed
 * runtime through `current`, so an update needs no rewrite, with the stack the
 * service uses. Checking or updating a device then needs no npm download.
 */
export function writeWorkerShim(
  name: string,
  node: string = process.execPath,
): string | undefined {
  if (process.platform !== "darwin" && process.platform !== "linux")
    return undefined;
  const path = workerShimPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const stack = ["FOUNDRY_STACK", "FOUNDRY_STATE_ROOT"]
    .map((key) => [key, process.env[key]?.trim()] as const)
    .filter(([, value]) => value)
    .map(([key, value]) => `export ${key}=${shellQuote(value!)}\n`)
    .join("");
  writeFileSync(
    path,
    `#!/bin/sh\n# Foundry worker on this machine; written by install and update.\n${stack}exec ${shellQuote(node)} ${shellQuote(currentRuntimeCli(name))} "$@"\n`,
    { mode: 0o755 },
  );
  return path;
}

function reportWorkerShim(name: string): void {
  const path = writeWorkerShim(name);
  if (!path) return;
  const shown = homeRelative(path);
  console.log(
    `Run \`${shown} doctor\` to check this device, \`${shown} update\` to update it.`,
  );
}

/** Version of the installed runtime in use, if `install` installed one. */
export function currentRuntimeVersion(name: string): string | undefined {
  try {
    return (
      JSON.parse(
        readFileSync(
          join(runtimeRoot(), "current", "node_modules", name, "package.json"),
          "utf8",
        ),
      ) as PackageIdentity
    ).version;
  } catch {
    return undefined;
  }
}

/** What `install` finds on this machine for this stack. */
export interface ExistingWorker {
  serverURL?: string;
  paired: boolean;
  serviceInstalled: boolean;
}

export function existingWorker(): ExistingWorker {
  const config = readDaemonConfig();
  return {
    serverURL: config?.serverURL,
    paired: Boolean(config?.deviceCredential),
    serviceInstalled: serviceInstalled(),
  };
}

/**
 * The decision `install` makes about an existing worker: nothing to do when
 * this machine already runs a worker for that server, refuse when it belongs
 * to another server, otherwise install.
 */
export function installDecision(
  existing: ExistingWorker,
  serverURL: string,
): "install" | "already-installed" | "other-server" {
  if (!existing.paired || !existing.serviceInstalled) return "install";
  return existing.serverURL === serverURL
    ? "already-installed"
    : "other-server";
}

/**
 * Install package specs into the runtime directory and make them current.
 * Specs are what npm installs: `<name>@<version>` from the registry, or local
 * tarballs (`--from`). Returns the installed version.
 */
export function installRuntime(name: string, specs: string[]): string {
  mkdirSync(runtimeRoot(), { recursive: true, mode: 0o700 });
  const staging = join(runtimeRoot(), `.staging-${process.pid}-${Date.now()}`);
  mkdirSync(staging, { recursive: true });
  // A package.json keeps npm from walking up to an unrelated project.
  spawnSync("npm", ["init", "-y"], { cwd: staging, stdio: "ignore" });
  const install = (packages: string[]) =>
    spawnSync("npm", [...runtimeInstallArgs(staging), ...packages], {
      encoding: "utf8",
      stdio: ["ignore", "inherit", "inherit"],
    }).status === 0;
  if (!install(specs)) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`npm could not install ${specs.join(" ")}`);
  }
  const manifest = JSON.parse(
    readFileSync(join(staging, "node_modules", name, "package.json"), "utf8"),
  ) as RuntimeManifest;
  const { required } = runtimeCompanions(manifest);
  if (required.length && !install(required)) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`npm could not install ${required.join(" ")}`);
  }
  const version = manifest.version;
  const current = join(runtimeRoot(), "current");
  let inUse: string | undefined;
  try {
    inUse = readlinkSync(current);
  } catch {
    inUse = undefined;
  }
  // A running worker's files are never replaced in place: reinstalling the
  // version in use (say, from a local build) goes into a directory of its own.
  const directory =
    inUse === undefined || runtimeVersion(inUse) !== version
      ? version
      : `${version}+${Date.now()}`;
  const target = join(runtimeRoot(), directory);
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  // Switch atomically: a service restarting now sees the old or new runtime.
  const next = join(runtimeRoot(), `.current-${process.pid}`);
  rmSync(next, { force: true });
  symlinkSync(directory, next);
  renameSync(next, current);
  pruneRuntimes(directory, inUse);
  return version;
}

interface RuntimeManifest extends PackageIdentity {
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  optionalDependencies?: Record<string, string>;
}

/**
 * npm arguments for the runtime. Optional packages are left out: the agent
 * SDKs list their own copies of the Claude Code and Codex programs (hundreds
 * of megabytes) as optional, and Foundry runs the device's programs instead.
 */
export function runtimeInstallArgs(prefix: string): string[] {
  return [
    "install",
    "--no-audit",
    "--no-fund",
    "--omit=dev",
    "--omit=optional",
    // Packages already in npm's cache are used as they are: a slow registry
    // is then asked only for what this machine has never downloaded.
    "--prefer-offline",
    "--prefix",
    prefix,
  ];
}

/**
 * What the runtime installs beside the worker: its optional peers, the agent
 * SDKs at the versions it was built with.
 */
export function runtimeCompanions(manifest: RuntimeManifest): {
  required: string[];
} {
  const optionalPeers = Object.entries(manifest.peerDependencies ?? {}).filter(
    ([peer]) => manifest.peerDependenciesMeta?.[peer]?.optional,
  );
  return {
    required: optionalPeers.map(([peer, range]) => `${peer}@${range}`),
  };
}

/** Keep the runtime in use and the one before it; remove older ones. */
/** The version a runtime directory holds; a reinstall adds "+<time>". */
export function runtimeVersion(directory: string): string {
  return directory.split("+")[0]!;
}

function pruneRuntimes(current: string, previous: string | undefined): void {
  for (const entry of readdirSync(runtimeRoot())) {
    if (entry === "current" || entry === current || entry === previous)
      continue;
    rmSync(join(runtimeRoot(), entry), { recursive: true, force: true });
  }
}

/** Latest published version of the package, from the npm registry. */
export function latestPublishedVersion(name: string): string {
  const result = spawnSync("npm", ["view", name, "version"], {
    encoding: "utf8",
  });
  const version = result.stdout?.trim();
  if (result.status !== 0 || !version)
    throw new Error(
      `could not read the latest version of ${name} from npm: ${(result.stderr || "").trim()}`,
    );
  return version;
}

/** `--from <spec>` (repeatable) overrides where the package comes from. */
function packageSpecs(args: string[]): string[] {
  const specs: string[] = [];
  for (let i = 0; i < args.length; i++)
    if (args[i] === "--from" && args[i + 1]) specs.push(args[++i]!);
  return specs;
}

/**
 * Where the server's worker comes from. A server that predates
 * `/api/worker/release` (404) serves no packages, so its workers use npm.
 */
export async function serverWorkerRelease(
  serverURL: string,
  retryDelaysMs = [2000, 5000],
): Promise<WorkerRelease> {
  // A server restarting (502/503) or a dropped connection is retried.
  for (let attempt = 0; ; attempt++) {
    let response: Response | undefined;
    let failure: string;
    try {
      response = await fetch(`${serverURL}/api/worker/release`);
      if (response.status === 404) return { source: "npm" };
      if (response.ok) return (await response.json()) as WorkerRelease;
      failure = `HTTP ${response.status}: ${(await response.text()).trim()}`;
    } catch (error) {
      failure = networkFailure(error);
    }
    const retryable = !response || response.status >= 500;
    if (!retryable || attempt >= retryDelaysMs.length)
      throw new Error(
        `could not ask ${serverURL} which worker it serves (${failure})`,
      );
    await new Promise((done) => setTimeout(done, retryDelaysMs[attempt]));
  }
}

/**
 * Why a request never got an answer. fetch reports only "fetch failed"; the
 * reason (DNS, refused, reset, certificate, proxy) is in its cause.
 */
export function networkFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error
      ? (error.cause as Error & { code?: string })
      : undefined;
  if (!cause) return message;
  const detail = [cause.code, cause.message].filter(Boolean).join(" ");
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  return `${message}: ${detail}${proxy ? `; HTTPS_PROXY is set, which Node's fetch does not use unless NODE_USE_ENV_PROXY=1` : ""}`;
}

/** npm specs for a server's packages; their URLs are relative to the server. */
export function serverPackageSpecs(
  release: Extract<WorkerRelease, { source: "server" }>,
  serverURL: string,
): string[] {
  return release.packages.map((pkg) =>
    pkg.url.startsWith("/") ? `${serverURL}${pkg.url}` : pkg.url,
  );
}

export async function installCommand(args: string[]): Promise<void> {
  const serverURL = optionValue(args, "--server")?.replace(/\/+$/, "");
  if (!serverURL)
    throw new Error(
      "install needs --server <url>: copy the command from Devices → Add device.",
    );
  // One command for any machine: the worker paired with this server, in
  // whichever stack, is brought to the server's version.
  if (rerunUnderPairedStack(serverURL)) return;
  const existing = existingWorker();
  const decision = installDecision(existing, serverURL);
  if (decision === "already-installed") {
    await updateCommand(args.filter((arg) => arg !== "--token"));
    return;
  }
  if (decision === "other-server")
    throw new Error(
      `This machine's Foundry worker belongs to ${existing.serverURL}. Run \`uninstall\` first, or install another stack with FOUNDRY_STACK=<name>.`,
    );
  if (!existing.paired && !optionValue(args, "--token"))
    throw new Error(
      `This machine is not paired with ${serverURL} yet; pairing needs a one-time token. Copy the command from Devices → Add device on ${serverURL} and run it here.`,
    );
  const self = ownPackage();
  // No default workspace: a new device starts with none, and the person adds
  // the folders they want from the Workspaces page.
  const workspace = optionValue(args, "--workspace");
  if (workspace) mkdirSync(workspace, { recursive: true });
  console.log(`Installing ${self.name} into ${runtimeRoot()}…`);
  let specs = packageSpecs(args);
  if (!specs.length) {
    const release = await serverWorkerRelease(serverURL);
    if (handOffToServedBuild(release, serverURL)) return;
    specs =
      release.source === "server"
        ? serverPackageSpecs(release, serverURL)
        : [`${self.name}@${self.version}`];
  }
  const installed = currentRuntimeVersion(self.name);
  const version = handedOff(installed)
    ? installed!
    : installRuntime(self.name, specs);
  console.log(`Installed ${self.name} ${version}.`);
  await setup(
    [
      ...withoutOption(args, "--from"),
      ...(workspace ? ["--workspace", workspace] : []),
    ],
    {
      cliPath: currentRuntimeCli(self.name),
      macApp: process.platform === "darwin",
    },
  );
  reportWorkerShim(self.name);
}

const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, "");

/**
 * Re-runs this command with the build the server serves when this CLI is a
 * different build (a cached npx copy of a stable URL, or the installed
 * runtime updating itself), so the newest installer does the work. Returns
 * true when that run did it.
 */
function handOffToServedBuild(
  release: WorkerRelease,
  serverURL: string,
): boolean {
  if (release.source !== "server") return false;
  const self = ownPackage();
  if (self.version === release.version) return false;
  // The handed-off run never hands off again.
  if (process.env.FOUNDRY_WORKER_HANDOFF === release.version) return false;
  console.log(
    `Installing the worker ${release.version} that ${serverURL} serves…`,
  );
  // Straight into the runtime directory (no npx copy), then that build does
  // the rest of this command.
  const previous = currentRuntimeVersion(self.name);
  if (previous !== release.version)
    installRuntime(self.name, serverPackageSpecs(release, serverURL));
  const run = spawnSync(
    process.execPath,
    [currentRuntimeCli(self.name), ...process.argv.slice(2)],
    {
      env: {
        ...process.env,
        FOUNDRY_WORKER_HANDOFF: release.version,
        FOUNDRY_WORKER_PREVIOUS: previous ?? "",
      },
      stdio: "inherit",
    },
  );
  process.exitCode = run.status ?? 1;
  return true;
}

/** This run was handed the build already installed as the current runtime. */
const handedOff = (version: string | undefined) =>
  version !== undefined && process.env.FOUNDRY_WORKER_HANDOFF === version;

type StateRoots = { default: string; stacks: string };
const machineRoots: StateRoots = {
  default: defaultStateRoot,
  stacks: stackStateParent,
};

/**
 * The workers paired on this machine: their stack ("" for the default one,
 * `~/.foundry`; else a name under `~/.foundry-stacks`) and server.
 */
export function pairedStacks(
  roots: StateRoots = machineRoots,
): { stack: string; serverURL: string }[] {
  const stacks = existsSync(roots.stacks)
    ? readdirSync(roots.stacks, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => [entry.name, join(roots.stacks, entry.name)])
    : [];
  const paired: { stack: string; serverURL: string }[] = [];
  for (const [stack, root] of [["", roots.default], ...stacks]) {
    const path = join(root!, "daemon-config.json");
    if (!existsSync(path)) continue;
    const { serverURL } = JSON.parse(readFileSync(path, "utf8")) as {
      serverURL?: string;
    };
    if (serverURL) paired.push({ stack: stack!, serverURL });
  }
  return paired;
}

/** The stack whose worker is paired with `serverURL`, if any. */
export function stackPairedWith(
  serverURL: string,
  roots: StateRoots = machineRoots,
): string | undefined {
  const target = withoutTrailingSlash(serverURL);
  return pairedStacks(roots).find(
    (paired) => withoutTrailingSlash(paired.serverURL) === target,
  )?.stack;
}

/**
 * Re-runs this command under the stack whose worker is paired with
 * `serverURL`, when that is not the current one, so a command a server shows
 * works whichever stack holds its worker. Returns true when the re-run did it.
 */
function rerunUnderPairedStack(serverURL: string): boolean {
  if (process.env.FOUNDRY_STATE_ROOT?.trim()) return false;
  const paired = readDaemonConfig()?.serverURL;
  if (
    paired &&
    withoutTrailingSlash(paired) === withoutTrailingSlash(serverURL)
  )
    return false;
  const stack = stackPairedWith(serverURL);
  if (stack === undefined) return false;
  const env = { ...process.env };
  if (stack) env.FOUNDRY_STACK = stack;
  else delete env.FOUNDRY_STACK;
  const rerun = spawnSync(process.execPath, process.argv.slice(1), {
    env,
    stdio: "inherit",
  });
  process.exitCode = rerun.status ?? 1;
  return true;
}

export async function updateCommand(args: string[]): Promise<void> {
  // An update started from the web holds the device's update lock until here.
  try {
    await runUpdate(args);
  } finally {
    releaseSelfUpdateLock();
  }
}

async function runUpdate(args: string[]): Promise<void> {
  const server = optionValue(args, "--server")?.replace(/\/+$/, "");
  if (server) {
    if (rerunUnderPairedStack(server)) return;
    // Not paired with that server here: `install` says what pairing needs.
    const paired = readDaemonConfig()?.serverURL;
    if (!paired || withoutTrailingSlash(paired) !== server)
      return installCommand(args);
  }
  const self = ownPackage();
  const current = currentRuntimeVersion(self.name);
  if (!current || !serviceInstalled())
    throw new Error(
      "This machine has no worker installed with `install`; nothing to update. A worker run from a source checkout updates with git.",
    );
  let specs = packageSpecs(args);
  if (!specs.length) {
    // The worker follows its server: the packages it serves, else npm.
    const serverURL = readDaemonConfig()?.serverURL;
    const release = serverURL
      ? await serverWorkerRelease(serverURL)
      : ({ source: "npm" } as const);
    const target =
      release.source === "server"
        ? release.version
        : latestPublishedVersion(self.name);
    if (
      release.source === "server" &&
      handOffToServedBuild(release, serverURL!)
    )
      return;
    if (target === current && !handedOff(current)) {
      console.log(
        release.source === "server"
          ? `${self.name} ${current} is already the version ${serverURL} serves.`
          : `${self.name} ${current} is already the latest version.`,
      );
      reportWorkerShim(self.name);
      return;
    }
    specs =
      release.source === "server"
        ? serverPackageSpecs(release, serverURL!)
        : [`${self.name}@${target}`];
  }
  const version = handedOff(current)
    ? current
    : installRuntime(self.name, specs);
  const restarted = await reinstallService({
    cliPath: currentRuntimeCli(self.name),
    macApp: process.platform === "darwin",
  });
  // A handed-off run's runtime was switched by the build that handed off.
  const before =
    (handedOff(current) && process.env.FOUNDRY_WORKER_PREVIOUS) || current;
  const done =
    version === before
      ? `Reinstalled ${self.name} ${version}`
      : `Updated ${self.name} ${before} → ${version}`;
  console.log(
    restarted
      ? `${done} and restarted the worker.`
      : `${done}; start the worker as shown above.`,
  );
  reportWorkerShim(self.name);
}

export async function uninstallCommand(args: string[]): Promise<void> {
  if (serviceInstalled()) uninstallService();
  await stopDaemonProcess();
  removeWorkerApp();
  if (optionEnabled(args, "--purge")) {
    rmSync(foundryStateRoot(), { recursive: true, force: true });
    console.log(
      `Removed ${foundryStateRoot()}: pairing, runtime and local records. The device stays listed on the server until removed there.`,
    );
    return;
  }
  console.log(
    "The worker is stopped and no longer starts at login. Pairing and workspaces are kept; `install` sets it up again, `uninstall --purge` removes them.",
  );
}

function withoutOption(args: string[], name: string): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      i++;
      continue;
    }
    kept.push(args[i]!);
  }
  return kept;
}
