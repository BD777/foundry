import {
  existsSync,
  mkdirSync,
  copyFileSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { canonical } from "./execution-storage.js";
import {
  defaultStateRoot,
  foundryStatePath,
  foundryStateRoot,
  stackStateParent,
} from "./state-root.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  IssueEnvironment,
  WorkspaceRegistration,
} from "./execution-types.js";

export function controlNetworkRestrictions(serverURL?: string): string[] {
  const ports = new Set(["31982", "31983"]);
  if (serverURL) {
    const url = new URL(serverURL);
    ports.add(url.port || (url.protocol === "https:" ? "443" : "80"));
  }
  // Block this port to every address, including host LAN IP and IPv6 aliases.
  return [...ports].map(
    (port) => `(deny network-outbound (remote tcp "*:${port}"))`,
  );
}

/** The one private-state subdir an issue executor may read skill files from. */
function skillSetsReadRoot(): string {
  return foundryStatePath("skill-sets");
}

/**
 * Install prefixes of the Node runtime and of the launched executable. Tool
 * managers (nvm, ~/.local, npm-global) keep them outside the system roots,
 * so without these the sandbox cannot even exec the agent CLI. A prefix that
 * is the home directory or overlaps private control state is never exposed.
 */
export function executableReadRoots(
  command: string,
  controlPaths: string[],
): string[] {
  const home = canonical(homedir());
  const roots = new Set<string>();
  for (const file of [process.execPath, command]) {
    if (!isAbsolute(file) || !existsSync(file)) continue;
    const directory = dirname(realpathSync(file));
    roots.add(
      canonical(basename(directory) === "bin" ? dirname(directory) : directory),
    );
  }
  return [...roots].filter(
    (root) =>
      root !== "/" &&
      root !== home &&
      !controlPaths.some(
        (control) =>
          control === root ||
          control.startsWith(`${root}/`) ||
          root.startsWith(`${control}/`),
      ),
  );
}

export function sandboxCommand(
  environment: IssueEnvironment,
  registration: WorkspaceRegistration,
  command: string,
  args: string[],
): { command: string; args: string[] } {
  const writable = [environment.cwd, environment.scratch].map(canonical);
  const denied = registration.repositories
    .filter(
      (repo) =>
        !environment.repositories.some(
          (candidate) =>
            candidate.repoId === repo.id && candidate.status === "ready",
        ),
    )
    .map((repo) => resolve(environment.cwd, repo.relativePath));
  const gitFiles = environment.repositories.map((repo) =>
    resolve(repo.worktreePath, ".git"),
  );
  // Every stack's private state stays unreadable, not only the active one:
  // parallel stacks must not be able to read each other's evidence or state.
  const controlPaths = [
    defaultStateRoot,
    stackStateParent,
    foundryStateRoot(),
    resolve(homedir(), ".config"),
    resolve(homedir(), "Library"),
    resolve(homedir(), ".ssh"),
  ]
    .filter(existsSync)
    .map(canonical);
  const runtimeRoot = canonical(
    fileURLToPath(new URL("../../../", import.meta.url)),
  );
  const systemRootPaths = [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/System",
    "/Library",
    "/opt/homebrew",
    "/Applications",
  ].filter(existsSync);
  const systemRoots = systemRootPaths.map(canonical);
  systemRoots.push(...executableReadRoots(command, controlPaths));
  if (process.platform === "darwin") {
    if (!existsSync("/usr/bin/sandbox-exec"))
      throw new Error("Issue isolation requires sandbox-exec on this device");
    const quote = (value: string): string => JSON.stringify(value);
    const skillReadRule =
      "(allow file-read-data (subpath " + quote(skillSetsReadRoot()) + "))";
    const profile = [
      "(version 1)",
      "(allow default)",
      "(deny file-read-data)",
      '(allow file-read-data (literal "/") (subpath "/private/etc") (subpath "/private/var/db"))',
      "(deny process-info*)",
      // libdispatch in the native Claude CLI needs its own unique pid.
      // Other process metadata (including the Server environment) stays denied.
      "(allow process-info* (target self))",
      ...[...systemRoots, runtimeRoot, environment.sourcePath, ...writable].map(
        (path) => `(allow file-read-data (subpath ${quote(canonical(path))}))`,
      ),
      '(allow file-read-data (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
      ...controlPaths.map(
        (path) => `(deny file-read-data (subpath ${quote(path)}))`,
      ),
      // Re-allow only the verified promoted-skill tree under private state.
      // It contains just downloaded, checksum-checked skill packages.
      skillReadRule,
      // Re-allow only this candidate/scratch under private execution storage.
      ...writable.map(
        (path) => `(allow file-read-data (subpath ${quote(path)}))`,
      ),
      '(deny file-read-data (regex #"/\\\\.env([^/]*$|/)"))',
      `(deny file-read-data (subpath ${quote(resolve(runtimeRoot, ".data"))}))`,
      `(deny file-read-data (subpath ${quote(resolve(runtimeRoot, "apps/server/.data"))}))`,
      // Deny access to the local control plane and its credential-bearing UI.
      ...controlNetworkRestrictions(environment.controlServerURL),
      "(deny file-write*)",
      '(allow file-write* (literal "/dev/null"))',
      ...writable.map((path) => `(allow file-write* (subpath ${quote(path)}))`),
      ...[...denied, ...gitFiles].map(
        (path) => `(deny file-write* (subpath ${quote(canonical(path))}))`,
      ),
    ].join("\n");
    // Profile remains outside candidate/scratch: the executor cannot change it.
    const profilePath = resolve(environment.directory, "executor.sb");
    writeFileSync(profilePath, profile, { mode: 0o600 });
    return {
      command: "/usr/bin/sandbox-exec",
      args: ["-f", profilePath, command, ...args],
    };
  }
  if (process.platform === "linux") {
    const executable = ["/usr/bin/bwrap", "/bin/bwrap"].find(existsSync);
    if (!executable)
      throw new Error(
        "Linux Issue isolation requires bubblewrap (bwrap); install it and enable user namespaces",
      );
    const probe = spawnSync(
      executable,
      [
        "--ro-bind",
        "/",
        "/",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--",
        "/bin/true",
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    if (probe.status !== 0)
      throw new Error(
        `Linux user namespaces are unavailable: ${probe.stderr?.trim() || probe.error?.message || "bubblewrap probe failed"}`,
      );
    // Mount source and host data read-only; only this candidate and scratch
    // are writable. Bind nested repository boundaries back to read-only.
    for (const path of denied) mkdirSync(path, { recursive: true });
    const options = [
      "--die-with-parent",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--new-session",
      "--tmpfs",
      "/",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
    ];
    for (const path of [...systemRoots, runtimeRoot, environment.sourcePath])
      options.push("--ro-bind", path, path);
    // Merged-/usr distributions make /bin, /lib and /lib64 symlinks into
    // /usr. Only the targets are mounted above, so recreate the links: the
    // ELF interpreter is addressed as /lib64/ld-linux-*.so.
    for (const path of systemRootPaths)
      if (lstatSync(path).isSymbolicLink())
        options.push("--symlink", readlinkSync(path), path);
    // Mount only the verified promoted-skill tree from private state.
    mkdirSync(skillSetsReadRoot(), { recursive: true });
    options.push("--ro-bind", skillSetsReadRoot(), skillSetsReadRoot());
    // No host /proc: process environments and daemon control credentials
    // are outside this PID namespace.
    for (const path of writable) options.push("--bind", path, path);
    for (const path of [...denied, ...gitFiles])
      options.push("--ro-bind", path, path);
    // Exec the resolved file: a symlink such as ~/.local/bin/claude lives in a
    // directory that is deliberately not mounted.
    const resolvedCommand =
      isAbsolute(command) && existsSync(command)
        ? realpathSync(command)
        : command;
    return {
      command: executable,
      args: [
        ...options,
        "--chdir",
        environment.cwd,
        "--",
        resolvedCommand,
        ...args,
      ],
    };
  }
  // Fail closed until a backend has been verified on this OS. CWD alone is
  // deliberately never treated as write isolation.
  throw new Error(
    `Issue execution isolation is not available on ${process.platform}`,
  );
}

export function executorEnvironment(
  environment: IssueEnvironment,
): NodeJS.ProcessEnv {
  const codexHome = resolve(environment.scratch, "codex");
  const claudeHome = resolve(environment.scratch, "claude");
  const temp = resolve(environment.scratch, "tmp");
  for (const directory of [codexHome, claudeHome, temp])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Provider authentication stays private and is never staged in the candidate.
  for (const [source, target] of [
    [
      resolve(
        process.env.CODEX_HOME ?? resolve(homedir(), ".codex"),
        "auth.json",
      ),
      resolve(codexHome, "auth.json"),
    ],
    [
      resolve(
        process.env.CODEX_HOME ?? resolve(homedir(), ".codex"),
        "config.toml",
      ),
      resolve(codexHome, "config.toml"),
    ],
    [
      resolve(
        process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), ".claude"),
        ".credentials.json",
      ),
      resolve(claudeHome, ".credentials.json"),
    ],
  ]) {
    if (source && target && existsSync(source) && !existsSync(target))
      copyFileSync(source, target);
  }
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (/FOUNDRY.*(?:TOKEN|PAIRING|CONTROL|CREDENTIAL)/i.test(key))
      delete inherited[key];
  }
  return {
    ...inherited,
    HOME: environment.scratch,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    TMPDIR: temp,
    CLAUDE_CODE_TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    FOUNDRY_WORKSPACE: environment.cwd,
    FOUNDRY_ROOT_WORKSPACE: environment.sourcePath,
    FOUNDRY_EXECUTION_SESSION_ROOT: resolve(environment.scratch, "sessions"),
  };
}
