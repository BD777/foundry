import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute } from "node:path";
import { canonical, within } from "../paths.js";
import {
  commandReadRoots,
  executableReadRoots,
  governanceStatePaths,
  offlineCommandSystemRoots,
  protectedHostPaths,
  runtimeRoot,
  runtimeServerData,
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
 * Linux bubblewrap mounts. Agent-facing kinds share the host network;
 * offline commands get no network at all. See docs/architecture-modules.md §5.1.
 */
export const bubblewrapBackend: SandboxBackend = {
  id: "bubblewrap",
  kinds: ["writable_tree", "readonly_agent", "offline_command"],
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
 * After every mount is in place, make the scratch root and the masking
 * directories read-only: writes to unmounted or masked paths then fail as
 * they do under macOS policies, instead of landing on an invisible tmpfs.
 */
function seal(masks: string[]): string[] {
  return [...masks, "/"].flatMap((path) => ["--remount-ro", path]);
}

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
 * user's home and the Foundry runtime, and the host configuration needed for
 * name resolution and TLS: /etc (as macOS policies allow /private/etc) plus
 * the target of a resolv.conf symlink such as systemd-resolved's stub file.
 * Governance state and the runtime's server data are covered by empty
 * directories; `masks` lists them so they can be sealed read-only.
 */
function hostMounts(
  commands: string[],
  options: { runtime: boolean; home: boolean },
): { mounts: string[]; masks: string[] } {
  const mounts: string[] = [];
  const masks: string[] = [];
  // The home goes first: a later mount of a parent would hide the mounts
  // made inside it, such as the runtime and its masked server data.
  const home = canonical(homedir());
  if (options.home && existsSync(home)) mounts.push("--ro-bind", home, home);
  const systemRootPaths = writableTreeSystemRoots();
  const roots = systemRootPaths.map(canonical);
  for (const command of commands)
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
  for (const path of roots) mounts.push("--ro-bind", path, path);
  const visible = (path: string) =>
    roots.some((root) => within(root, path)) ||
    (options.home && within(home, path));
  for (const path of [
    ...(options.runtime ? runtimeServerData(runtime) : []),
    ...governanceStatePaths(),
  ])
    if (existsSync(path) && visible(path)) {
      mounts.push("--tmpfs", path);
      masks.push(path);
    }
  // Merged-/usr distributions make /bin, /lib and /lib64 symlinks into
  // /usr. Only the targets are mounted above, so recreate the links: the
  // ELF interpreter is addressed as /lib64/ld-linux-*.so.
  for (const path of systemRootPaths)
    if (lstatSync(path).isSymbolicLink())
      mounts.push("--symlink", readlinkSync(path), path);
  return { mounts, masks };
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
  const host = hostMounts([command, ...profile.executables], {
    runtime: true,
    home: profile.userFiles === "readable",
  });
  const options = [...namespaces, ...host.mounts];
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
  options.push(...seal(host.masks));
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
  const host = hostMounts([command], { runtime: false, home: false });
  const options = [...namespaces, ...host.mounts];
  for (const path of profile.readRoots) options.push("--ro-bind", path, path);
  options.push("--bind", profile.home, profile.home, ...seal(host.masks));
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
