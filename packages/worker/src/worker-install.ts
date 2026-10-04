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
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { foundryStatePath, foundryStateRoot } from "./state-root.js";
import { optionEnabled, optionValue } from "./utils.js";

export interface PackageIdentity {
  name: string;
  version: string;
}

/** The package this CLI was run from. */
export function ownPackage(): PackageIdentity {
  const manifest = JSON.parse(
    readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
      "utf8",
    ),
  ) as PackageIdentity;
  return { name: manifest.name, version: manifest.version };
}

export function runtimeRoot(): string {
  return foundryStatePath("runtime");
}

/** The worker CLI of the runtime in use; the service starts this path. */
export function currentRuntimeCli(name: string): string {
  return join(runtimeRoot(), "current", "node_modules", name, "dist", "cli.js");
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
  const { required, bestEffort } = runtimeCompanions(manifest);
  if (required.length && !install(required)) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`npm could not install ${required.join(" ")}`);
  }
  for (const spec of bestEffort)
    if (!install([spec]))
      console.warn(
        `Could not install ${spec}; the features that need it (signing in from Foundry) stay unavailable on this machine.`,
      );
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
    "--prefix",
    prefix,
  ];
}

/**
 * What the runtime installs beside the worker: its optional peers (the agent
 * SDKs, at the versions it was built with) are required, and its optional
 * dependencies (node-pty, which compiles on Linux) are installed when they can be.
 */
export function runtimeCompanions(manifest: RuntimeManifest): {
  required: string[];
  bestEffort: string[];
} {
  const optionalPeers = Object.entries(manifest.peerDependencies ?? {}).filter(
    ([peer]) => manifest.peerDependenciesMeta?.[peer]?.optional,
  );
  return {
    required: optionalPeers.map(([peer, range]) => `${peer}@${range}`),
    bestEffort: Object.entries(manifest.optionalDependencies ?? {}).map(
      ([dependency, range]) => `${dependency}@${range}`,
    ),
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
function packageSpecs(args: string[], fallback: string): string[] {
  const specs: string[] = [];
  for (let i = 0; i < args.length; i++)
    if (args[i] === "--from" && args[i + 1]) specs.push(args[++i]!);
  return specs.length ? specs : [fallback];
}

export async function installCommand(args: string[]): Promise<void> {
  const serverURL = optionValue(args, "--server")?.replace(/\/+$/, "");
  if (!serverURL)
    throw new Error(
      "install needs --server <url>: copy the command from Devices → Add device.",
    );
  const existing = existingWorker();
  const decision = installDecision(existing, serverURL);
  if (decision === "already-installed") {
    console.log(
      `A Foundry worker is already installed on this machine for ${serverURL}; nothing was changed.`,
    );
    console.log(
      "Run `update` to upgrade it, or `status` to inspect it. To add a workspace, use Devices → the device → Workspaces.",
    );
    status();
    return;
  }
  if (decision === "other-server")
    throw new Error(
      `This machine's Foundry worker belongs to ${existing.serverURL}. Run \`uninstall\` first, or install another stack with FOUNDRY_STACK=<name>.`,
    );
  if (!existing.paired && !optionValue(args, "--token"))
    throw new Error(
      "install needs --token <pairing-token>: create one in Devices → Add device.",
    );
  const self = ownPackage();
  const workspace =
    optionValue(args, "--workspace") ?? join(homedir(), "Foundry");
  mkdirSync(workspace, { recursive: true });
  console.log(`Installing ${self.name} into ${runtimeRoot()}…`);
  const version = installRuntime(
    self.name,
    packageSpecs(args, `${self.name}@${self.version}`),
  );
  console.log(`Installed ${self.name} ${version}.`);
  await setup([...withoutOption(args, "--from"), "--workspace", workspace], {
    cliPath: currentRuntimeCli(self.name),
    macApp: process.platform === "darwin",
  });
}

export async function updateCommand(args: string[]): Promise<void> {
  const self = ownPackage();
  const current = currentRuntimeVersion(self.name);
  if (!current || !serviceInstalled())
    throw new Error(
      "This machine has no worker installed with `install`; nothing to update. A worker run from a source checkout updates with git.",
    );
  const explicit = args.includes("--from");
  const latest = explicit ? undefined : latestPublishedVersion(self.name);
  if (latest === current) {
    console.log(`${self.name} ${current} is already the latest version.`);
    return;
  }
  const version = installRuntime(
    self.name,
    packageSpecs(args, `${self.name}@${latest}`),
  );
  const restarted = await reinstallService({
    cliPath: currentRuntimeCli(self.name),
    macApp: process.platform === "darwin",
  });
  const done =
    version === current
      ? `Reinstalled ${self.name} ${version}`
      : `Updated ${self.name} ${current} → ${version}`;
  console.log(
    restarted
      ? `${done} and restarted the worker.`
      : `${done}; start the worker as shown above.`,
  );
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
