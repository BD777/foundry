import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { canonical, within } from "../paths.js";
import {
  commandReadRoots,
  executableReadRoots,
  offlineCommandSystemRoots,
  protectedHostPaths,
  runtimeRoot,
  writableTreeSystemRoots,
} from "./host.js";
import {
  SandboxError,
  type OfflineCommandProfile,
  type ReadonlyAgentProfile,
  type SandboxBackend,
  type SandboxLaunch,
  type WritableTreeProfile,
} from "./types.js";

/**
 * Linux bubblewrap mounts. bwrap cannot filter ports, so agent-facing kinds
 * share the host network and do not block the control plane; offline commands
 * get no network at all. See docs/architecture-modules.md §5.1.
 */
export const bubblewrapBackend: SandboxBackend = {
  id: "bubblewrap",
  guarantees: {
    writable_tree: { controlPlaneBlocked: false },
    readonly_agent: { controlPlaneBlocked: false },
    offline_command: { controlPlaneBlocked: true },
  },
  launch(profile, command, args) {
    switch (profile.kind) {
      case "writable_tree":
        return writableTree(profile, command, args);
      case "readonly_agent":
        return readonlyAgent(profile, command, args);
      case "offline_command":
        return offlineCommand(profile, command, args);
      case "loopback_service":
        throw new SandboxError(
          "unsupported_platform",
          "loopback_service isolation is not available on linux",
        );
    }
  },
};

const namespaces = [
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

/**
 * After every mount is in place, make the scratch root read-only: writes to
 * unmounted paths then fail as they do under macOS policies, instead of
 * landing on an invisible tmpfs.
 */
const sealRoot = ["--remount-ro", "/"];

/** The bwrap executable, after checking that user namespaces work here. */
function bubblewrap(): string {
  const executable = ["/usr/bin/bwrap", "/bin/bwrap"].find(existsSync);
  if (!executable)
    throw new SandboxError(
      "backend_missing",
      "requires bubblewrap (bwrap); install it and enable user namespaces",
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
    throw new SandboxError(
      "user_namespaces_unavailable",
      probe.stderr?.trim() || probe.error?.message || "bubblewrap probe failed",
    );
  return executable;
}

/**
 * Read-only system roots, the install prefixes of the command, optionally the
 * Foundry runtime, and the host configuration needed for name resolution and
 * TLS: /etc (as macOS policies allow /private/etc) plus the target of a
 * resolv.conf symlink such as systemd-resolved's stub file.
 */
function systemMounts(
  command: string,
  options: { runtime: boolean },
): string[] {
  const systemRootPaths = writableTreeSystemRoots();
  const roots = systemRootPaths.map(canonical);
  roots.push(...executableReadRoots(command, protectedHostPaths()));
  const runtime = runtimeRoot();
  if (options.runtime) roots.push(runtime);
  if (existsSync("/etc")) {
    roots.push("/etc");
    const resolver = "/etc/resolv.conf";
    if (existsSync(resolver)) {
      const target = dirname(realpathSync(resolver));
      if (!roots.some((root) => within(root, target))) roots.push(target);
    }
  }
  const mounts: string[] = [];
  for (const path of roots) mounts.push("--ro-bind", path, path);
  // The runtime's server data (database, secret key) stays hidden, as the
  // macOS policy denies reading it.
  if (options.runtime)
    for (const data of [".data", "apps/server/.data"].map((path) =>
      resolve(runtime, path),
    ))
      if (existsSync(data)) mounts.push("--tmpfs", data);
  // Merged-/usr distributions make /bin, /lib and /lib64 symlinks into
  // /usr. Only the targets are mounted above, so recreate the links: the
  // ELF interpreter is addressed as /lib64/ld-linux-*.so.
  for (const path of systemRootPaths)
    if (lstatSync(path).isSymbolicLink())
      mounts.push("--symlink", readlinkSync(path), path);
  return mounts;
}

function outermost(paths: string[]): string[] {
  return paths.filter(
    (path) => !paths.some((other) => other !== path && within(other, path)),
  );
}

/**
 * Exec the resolved file: a symlink such as ~/.local/bin/claude lives in a
 * directory that is deliberately not mounted.
 */
function resolvedCommand(command: string): string {
  return isAbsolute(command) && existsSync(command)
    ? realpathSync(command)
    : command;
}

function writableTree(
  profile: WritableTreeProfile,
  command: string,
  args: string[],
): SandboxLaunch {
  const executable = bubblewrap();
  // Mount read roots and host data read-only; only the writable roots are
  // writable. Bind read-only directories inside them back to read-only. A
  // directory inside another read-only one needs no mount of its own, and
  // creating its mount point would leave it on the host.
  const readOnlyDirectories = outermost(profile.readOnlyDirectories);
  for (const path of readOnlyDirectories) mkdirSync(path, { recursive: true });
  const options = [...namespaces, ...systemMounts(command, { runtime: true })];
  for (const path of profile.readRoots) options.push("--ro-bind", path, path);
  // Mount only the named read-only trees from protected state.
  for (const path of profile.protectedReadRoots) {
    mkdirSync(path, { recursive: true });
    options.push("--ro-bind", path, path);
  }
  // No host /proc: process environments and daemon control credentials
  // are outside this PID namespace.
  for (const path of profile.writeRoots) options.push("--bind", path, path);
  for (const path of [...readOnlyDirectories, ...profile.readOnlyPaths])
    options.push("--ro-bind", path, path);
  // Connecting needs the socket inode, not write access to its file system.
  for (const path of profile.connectSockets)
    options.push("--ro-bind", path, path);
  options.push(...sealRoot);
  return {
    command: executable,
    args: [
      ...options,
      "--chdir",
      profile.workdir,
      "--",
      resolvedCommand(command),
      ...args,
    ],
  };
}

function readonlyAgent(
  profile: ReadonlyAgentProfile,
  command: string,
  args: string[],
): SandboxLaunch {
  const executable = bubblewrap();
  // Beyond these roots: no source trees, global user config, project skills or
  // original materials. Only the private home is ever writable.
  const options = [...namespaces, ...systemMounts(command, { runtime: false })];
  for (const path of profile.readRoots) options.push("--ro-bind", path, path);
  options.push("--bind", profile.home, profile.home, ...sealRoot);
  return {
    command: executable,
    args: [
      ...options,
      "--chdir",
      profile.workdir ?? profile.home,
      "--",
      command,
      ...args,
    ],
  };
}

function offlineCommand(
  profile: OfflineCommandProfile,
  command: string,
  args: string[],
): SandboxLaunch {
  const executable = "/usr/bin/bwrap";
  if (!existsSync(executable))
    throw new SandboxError(
      "backend_missing",
      "requires bubblewrap (bwrap); install it and enable user namespaces",
    );
  const options = [
    "--die-with-parent",
    "--unshare-all",
    "--new-session",
    "--tmpfs",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
  ];
  for (const root of [
    ...offlineCommandSystemRoots(),
    ...commandReadRoots(command),
    ...profile.readRoots,
  ])
    options.push("--ro-bind", root, root);
  options.push("--bind", profile.writeRoot, profile.writeRoot);
  for (const path of profile.readOnlyPaths)
    options.push("--ro-bind", path, path);
  return {
    command: executable,
    args: [...options, "--chdir", profile.workdir, "--", command, ...args],
  };
}
