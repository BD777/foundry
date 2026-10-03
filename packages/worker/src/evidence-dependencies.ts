import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type {
  CandidateSnapshot,
  InputDependency,
  SnapshotFile,
} from "@bd777/foundry-protocol";
import type { EvidenceStore } from "./evidence-store.js";
import { captureProcess } from "./evidence-collectors.js";
import { canonical, within } from "./paths.js";
import { isSandboxError, sandboxLaunch } from "./sandbox/index.js";
import { protectedHostPaths } from "./sandbox/host.js";

const exec = promisify(execFile);

type Manager = "pnpm" | "npm";

/** A tracked lockfile Foundry installs from before a project command runs. */
export interface DependencyLock {
  manager: Manager;
  /** Repository directory inside a candidate copy ("." for the root). */
  repoRelativePath: string;
  /** "<repo>/<lockfile>", as recorded in the verification input. */
  name: string;
  digest: string;
}

const lockfiles: Record<string, Manager> = {
  "pnpm-lock.yaml": "pnpm",
  "package-lock.json": "npm",
};

/** Lockfiles at each repository's root in the sealed candidate. */
export function dependencyLocks(
  candidate: CandidateSnapshot,
  store: EvidenceStore,
): DependencyLock[] {
  const manifest = JSON.parse(
    store.readMaterial(candidate.fileManifestMaterialId).toString(),
  ) as SnapshotFile[];
  const locks: DependencyLock[] = [];
  for (const file of manifest) {
    const manager = lockfiles[file.path];
    if (!manager || file.kind !== "file") continue;
    const repo = candidate.repositories.find((r) => r.repoId === file.repoId);
    if (!repo) continue;
    locks.push({
      manager,
      repoRelativePath: repo.relativePath,
      name:
        repo.relativePath === "."
          ? file.path
          : `${repo.relativePath}/${file.path}`,
      digest: file.digest,
    });
  }
  return locks.sort((a, b) => a.name.localeCompare(b.name));
}

/** The manager's frozen, offline install that never runs package code. */
function installArgs(lock: DependencyLock, version: string, cache: string) {
  if (lock.manager === "npm")
    return [
      "ci",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      cache,
    ];
  return [
    "install",
    "--frozen-lockfile",
    "--offline",
    // Without network the supply-chain re-check cannot run; offline means
    // only packages already in this device's store, fetched under that policy.
    ...(Number(version.split(".")[0]) >= 11 ? ["--trust-lockfile"] : []),
    "--ignore-scripts",
    "--ignore-pnpmfile",
    // Copies, not hard links: the project command must not reach the store.
    "--package-import-method",
    "copy",
    "--store-dir",
    cache,
  ];
}

export function installCommand(lock: DependencyLock): string {
  return lock.manager === "npm"
    ? "npm ci --offline --ignore-scripts"
    : "pnpm install --frozen-lockfile --offline --ignore-scripts";
}

/**
 * Where the manager keeps packages on this device, and its version. Asked
 * from a neutral directory that holds only the project's packageManager pin,
 * so a candidate's own configuration cannot name the directory Foundry then
 * makes writable for the install.
 */
export async function dependencyTooling(
  lock: DependencyLock,
  projectDirectory: string,
  scratch: string,
): Promise<{ version: string; cache: string } | undefined> {
  const neutral = resolve(scratch, `tooling-${lock.manager}`);
  mkdirSync(neutral, { recursive: true, mode: 0o700 });
  const packageJSON = resolve(projectDirectory, "package.json");
  let pin: string | undefined;
  try {
    pin = (
      JSON.parse(readFileSync(packageJSON, "utf8")) as {
        packageManager?: string;
      }
    ).packageManager;
  } catch {
    pin = undefined;
  }
  writeFileSync(
    resolve(neutral, "package.json"),
    JSON.stringify(pin ? { packageManager: pin } : {}),
  );
  const run = (args: string[]) =>
    exec(lock.manager, args, { cwd: neutral, timeout: 60_000 }).then((r) =>
      r.stdout.trim(),
    );
  try {
    const version = await run(["--version"]);
    const cache = canonical(
      await run(
        lock.manager === "npm" ? ["config", "get", "cache"] : ["store", "path"],
      ),
    );
    if (protectedHostPaths().some((path) => within(path, cache)))
      return undefined;
    return { version, cache };
  } catch {
    return undefined;
  }
}

export function inputDependency(
  lock: DependencyLock,
  version: string | undefined,
): InputDependency {
  return {
    name: lock.name,
    kind: "dependency_lock",
    sourceLabel: `${installCommand(lock)}${version ? ` (${lock.manager} ${version})` : ""}`,
    versionToken: lock.digest,
    revalidation: "immutable",
  };
}

/**
 * Installs a lockfile's dependencies into a check's candidate copy, offline
 * and without running package code. Writes reach only that repository's
 * directory in the copy, the device's package store or cache, and `output`.
 */
export async function prepareDependencies(
  locks: DependencyLock[],
  copyRoot: string,
  output: string,
): Promise<{ log: Buffer; failure?: string }> {
  const log: string[] = [];
  for (const lock of locks) {
    const directory =
      lock.repoRelativePath === "."
        ? copyRoot
        : resolve(copyRoot, lock.repoRelativePath);
    const tooling = await dependencyTooling(lock, directory, output);
    if (!tooling) {
      log.push(
        `${lock.name}: ${lock.manager} is not available on this device.`,
      );
      return { log: Buffer.from(log.join("\n")), failure: unavailable(lock) };
    }
    const home = resolve(output, "dependency-home");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const corepack = corepackHome();
    let launch;
    try {
      launch = sandboxLaunch(
        {
          kind: "offline_command",
          policyFile: resolve(output, `dependencies-${lock.manager}.sb`),
          workdir: directory,
          readRoots: corepack ? [corepack] : [],
          writeRoot: output,
          writeRoots: [directory, tooling.cache],
          readOnlyPaths: [],
        },
        lock.manager,
        installArgs(lock, tooling.version, tooling.cache),
      );
    } catch (error) {
      if (isSandboxError(error))
        throw new Error("verification_isolation_unavailable");
      throw error;
    }
    const result = await captureProcess({
      executable: launch.command,
      args: launch.args,
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        HOME: home,
        TMPDIR: output,
        ...(corepack ? { COREPACK_HOME: corepack } : {}),
        npm_config_logs_dir: output,
      },
      timeoutMs: 10 * 60_000,
    });
    log.push(
      `$ ${installCommand(lock)}  (${lock.name}, ${lock.manager} ${tooling.version})`,
      result.stdout.toString(),
      result.stderr.toString(),
      `exit ${result.exitCode ?? result.outcome}`,
    );
    if (result.outcome !== "completed" || result.exitCode !== 0)
      return { log: Buffer.from(log.join("\n")), failure: unavailable(lock) };
  }
  return { log: Buffer.from(log.join("\n")) };
}

/**
 * Corepack's cache of package-manager releases, read-only to sandboxed
 * commands so a pinned `pnpm` runs without downloading itself.
 */
export function corepackHome(): string | undefined {
  const path =
    process.env.COREPACK_HOME ??
    (process.platform === "darwin"
      ? resolve(homedir(), "Library/Caches/node/corepack")
      : resolve(homedir(), ".cache/node/corepack"));
  return existsSync(path) ? path : undefined;
}

function unavailable(lock: DependencyLock): string {
  const install = lock.manager === "npm" ? "npm ci" : "pnpm install";
  return `dependencies_unavailable: the dependencies in ${lock.name} are not available offline on this device. Run ${install} once in the workspace on this device, then check again.`;
}
