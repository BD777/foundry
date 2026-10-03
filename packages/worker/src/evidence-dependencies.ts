import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, resolve } from "node:path";
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

type Manager = "pnpm" | "npm" | "go";

/** A tracked lockfile Foundry installs from before a project command runs. */
export interface DependencyLock {
  manager: Manager;
  /** Repository directory inside a candidate copy ("." for the root). */
  repoRelativePath: string;
  /** The lockfile's directory inside its repository ("." for the root). */
  directoryRelativePath: string;
  /** "<repo>/<lockfile>", as recorded in the verification input. */
  name: string;
  digest: string;
}

const lockfiles: Record<string, Manager> = {
  "pnpm-lock.yaml": "pnpm",
  "package-lock.json": "npm",
};

/**
 * Lockfiles in the sealed candidate: npm/pnpm at each repository's root, and
 * every Go module's go.sum.
 */
export function dependencyLocks(
  candidate: CandidateSnapshot,
  store: EvidenceStore,
): DependencyLock[] {
  const manifest = JSON.parse(
    store.readMaterial(candidate.fileManifestMaterialId).toString(),
  ) as SnapshotFile[];
  const locks: DependencyLock[] = [];
  for (const file of manifest) {
    const manager =
      lockfiles[file.path] ??
      (posix.basename(file.path) === "go.sum" ? "go" : undefined);
    if (!manager || file.kind !== "file") continue;
    const repo = candidate.repositories.find((r) => r.repoId === file.repoId);
    if (!repo) continue;
    locks.push({
      manager,
      repoRelativePath: repo.relativePath,
      directoryRelativePath: posix.dirname(file.path),
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
  if (lock.manager === "go")
    return "go list -deps -test ./... (GOPROXY=off, device module cache)";
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
): Promise<{ version: string; cache: string; root?: string } | undefined> {
  const neutral = resolve(scratch, `tooling-${lock.manager}`);
  mkdirSync(neutral, { recursive: true, mode: 0o700 });
  if (lock.manager === "go") return goTooling(neutral);
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

/**
 * The Go toolchain's version, module cache and GOROOT, asked from a directory
 * with no go.mod or go.work, so the candidate cannot choose the cache.
 */
async function goTooling(
  neutral: string,
): Promise<{ version: string; cache: string; root: string } | undefined> {
  try {
    const go = (args: string[]) =>
      exec("go", args, {
        cwd: neutral,
        timeout: 60_000,
        env: { ...process.env, GOWORK: "off", GOFLAGS: "" },
      }).then((r) => r.stdout.trim());
    const version = (await go(["env", "GOVERSION"])).replace(/^go/, "");
    const [cache, root] = (await go(["env", "GOMODCACHE", "GOROOT"]))
      .split("\n")
      .map((path) => canonical(path.trim()));
    if (
      !version ||
      !cache ||
      !root ||
      protectedHostPaths().some(
        (path) => within(path, cache) || within(path, root),
      )
    )
      return undefined;
    return { version, cache, root };
  } catch {
    return undefined;
  }
}

/** What a command needs to build Go modules offline from the device's cache. */
function goSandbox(
  tooling: { cache: string; root: string },
  output: string,
): DependencySandbox {
  const root = tooling.root;
  return {
    readRoots: [tooling.cache, root],
    pathPrefix: resolve(root, "bin"),
    env: {
      GOMODCACHE: tooling.cache,
      GOROOT: root,
      GOPROXY: "off",
      GOFLAGS: "-mod=readonly",
      GOTOOLCHAIN: "local",
      GOENV: "off",
      GOCACHE: resolve(output, "go-build"),
      GOPATH: resolve(output, "gopath"),
    },
  };
}

/** Extra roots and environment a check's command runs with. */
export interface DependencySandbox {
  readRoots: string[];
  /** Prepended to PATH, so the command finds the same toolchain. */
  pathPrefix?: string;
  env: Record<string, string>;
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
 * Prepares each lockfile's dependencies for a check's candidate copy,
 * offline and without running package code. npm/pnpm install into that
 * repository's directory in the copy (writes reach only it, the device's
 * package store or cache, and `output`). Go modules are read from the
 * device's module cache, read-only; a preflight loads every package the
 * module and its tests need, so a missing module fails before the command.
 * Returns what the command itself then runs with.
 */
export async function prepareDependencies(
  locks: DependencyLock[],
  copyRoot: string,
  output: string,
): Promise<{ log: Buffer; failure?: string; sandbox: DependencySandbox }> {
  const log: string[] = [];
  const sandbox: DependencySandbox = { readRoots: [], env: {} };
  const fail = (lock: DependencyLock) => ({
    log: Buffer.from(log.join("\n")),
    failure: unavailable(lock),
    sandbox,
  });
  for (const lock of locks) {
    const repository =
      lock.repoRelativePath === "."
        ? copyRoot
        : resolve(copyRoot, lock.repoRelativePath);
    const directory = resolve(repository, lock.directoryRelativePath);
    const tooling = await dependencyTooling(lock, directory, output);
    if (!tooling) {
      log.push(
        `${lock.name}: ${lock.manager} is not available on this device.`,
      );
      return fail(lock);
    }
    const home = resolve(output, "dependency-home");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const corepack = corepackHome();
    const go =
      lock.manager === "go" && tooling.root
        ? goSandbox({ cache: tooling.cache, root: tooling.root }, output)
        : undefined;
    let launch;
    try {
      launch = sandboxLaunch(
        {
          kind: "offline_command",
          policyFile: resolve(output, `dependencies-${lock.manager}.sb`),
          workdir: directory,
          // Go only reads the module (and the modules beside it it replaces).
          readRoots: go
            ? [repository, ...go.readRoots]
            : corepack
              ? [corepack]
              : [],
          writeRoot: output,
          writeRoots: go ? [] : [directory, tooling.cache],
          readOnlyPaths: [],
        },
        go ? resolve(go.pathPrefix ?? "", "go") : lock.manager,
        go
          ? ["list", "-deps", "-test", "./..."]
          : installArgs(lock, tooling.version, tooling.cache),
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
        PATH: go
          ? `${go.pathPrefix}:${process.env.PATH ?? ""}`
          : process.env.PATH,
        LANG: "C.UTF-8",
        HOME: home,
        TMPDIR: output,
        ...(corepack ? { COREPACK_HOME: corepack } : {}),
        ...(go ? go.env : { npm_config_logs_dir: output }),
      },
      timeoutMs: 10 * 60_000,
    });
    log.push(
      `$ ${installCommand(lock)}  (${lock.name}, ${lock.manager} ${tooling.version})`,
      // A Go preflight lists every package; the log keeps only problems.
      go ? "" : result.stdout.toString(),
      result.stderr.toString(),
      `exit ${result.exitCode ?? result.outcome}`,
    );
    if (result.outcome !== "completed" || result.exitCode !== 0)
      return fail(lock);
    if (go) {
      for (const root of go.readRoots)
        if (!sandbox.readRoots.includes(root)) sandbox.readRoots.push(root);
      sandbox.pathPrefix = go.pathPrefix;
      Object.assign(sandbox.env, go.env);
    }
  }
  return { log: Buffer.from(log.join("\n")), sandbox };
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
  if (lock.manager === "go")
    return `dependencies_unavailable: the Go modules in ${lock.name} are not all in this device's module cache. Build and test the module once in the workspace on this device (go build ./... and go test ./...), then check again.`;
  const install = lock.manager === "npm" ? "npm ci" : "pnpm install";
  return `dependencies_unavailable: the dependencies in ${lock.name} are not available offline on this device. Run ${install} once in the workspace on this device, then check again.`;
}
