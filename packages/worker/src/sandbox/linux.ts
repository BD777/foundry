import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import { canonical } from "../paths.js";
import {
  executableReadRoots,
  offlineCommandSystemRoots,
  protectedHostPaths,
  runtimeRoot,
  writableTreeSystemRoots,
} from "./host.js";
import {
  SandboxError,
  type LaunchableProfile,
  type OfflineCommandProfile,
  type SandboxLaunch,
  type WritableTreeProfile,
} from "./index.js";

export function linuxLaunch(
  profile: LaunchableProfile,
  command: string,
  args: string[],
): SandboxLaunch {
  switch (profile.kind) {
    case "writable_tree":
      return writableTree(profile, command, args);
    case "offline_command":
      return offlineCommand(profile, command, args);
    case "loopback_service":
      throw new SandboxError(
        "unsupported_platform",
        "loopback_service isolation is not available on linux",
      );
  }
}

function writableTree(
  profile: WritableTreeProfile,
  command: string,
  args: string[],
): SandboxLaunch {
  const systemRootPaths = writableTreeSystemRoots();
  const systemRoots = systemRootPaths.map(canonical);
  systemRoots.push(...executableReadRoots(command, protectedHostPaths()));
  const runtime = runtimeRoot();
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
  // Mount read roots and host data read-only; only the writable roots are
  // writable. Bind read-only directories inside them back to read-only.
  for (const path of profile.readOnlyDirectories)
    mkdirSync(path, { recursive: true });
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
  for (const path of [...systemRoots, runtime, ...profile.readRoots])
    options.push("--ro-bind", path, path);
  // Merged-/usr distributions make /bin, /lib and /lib64 symlinks into
  // /usr. Only the targets are mounted above, so recreate the links: the
  // ELF interpreter is addressed as /lib64/ld-linux-*.so.
  for (const path of systemRootPaths)
    if (lstatSync(path).isSymbolicLink())
      options.push("--symlink", readlinkSync(path), path);
  // Mount only the named read-only trees from protected state.
  for (const path of profile.protectedReadRoots) {
    mkdirSync(path, { recursive: true });
    options.push("--ro-bind", path, path);
  }
  // No host /proc: process environments and daemon control credentials
  // are outside this PID namespace.
  for (const path of profile.writeRoots) options.push("--bind", path, path);
  for (const path of [...profile.readOnlyDirectories, ...profile.readOnlyPaths])
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
      profile.workdir,
      "--",
      resolvedCommand,
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
  for (const root of offlineCommandSystemRoots())
    options.push("--ro-bind", root, root);
  for (const root of profile.readRoots) options.push("--ro-bind", root, root);
  options.push("--bind", profile.writeRoot, profile.writeRoot);
  for (const path of profile.readOnlyPaths)
    options.push("--ro-bind", path, path);
  return {
    command: executable,
    args: [...options, "--chdir", profile.workdir, "--", command, ...args],
  };
}
