import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { canonical, within } from "../paths.js";
import {
  controlNetworkRestrictions,
  executableReadRoots,
  offlineCommandSystemRoots,
  protectedHostPaths,
  runtimeRoot,
  writableTreeSystemRoots,
} from "./host.js";
import {
  SandboxError,
  type LaunchableProfile,
  type LoopbackServiceProfile,
  type OfflineCommandProfile,
  type ReadonlyAgentProfile,
  type SandboxLaunch,
  type WritableTreeProfile,
} from "./index.js";

const sandboxExec = "/usr/bin/sandbox-exec";
const quote = (value: string): string => JSON.stringify(value);

export function darwinLaunch(
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
      return loopbackService(profile, command, args);
  }
}

function writableTree(
  profile: WritableTreeProfile,
  command: string,
  args: string[],
): SandboxLaunch {
  const controlPaths = protectedHostPaths();
  const runtime = runtimeRoot();
  const systemRoots = writableTreeSystemRoots().map(canonical);
  systemRoots.push(...executableReadRoots(command, controlPaths));
  if (!existsSync(sandboxExec))
    throw new SandboxError(
      "backend_missing",
      "requires sandbox-exec on this device",
    );
  const rules = [
    "(version 1)",
    "(allow default)",
    "(deny file-read-data)",
    '(allow file-read-data (literal "/") (subpath "/private/etc") (subpath "/private/var/db"))',
    "(deny process-info*)",
    // libdispatch in the native Claude CLI needs its own unique pid.
    // Other process metadata (including the Server environment) stays denied.
    "(allow process-info* (target self))",
    ...[
      ...systemRoots,
      runtime,
      ...profile.readRoots,
      ...profile.writeRoots,
    ].map(
      (path) => `(allow file-read-data (subpath ${quote(canonical(path))}))`,
    ),
    '(allow file-read-data (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
    ...controlPaths.map(
      (path) => `(deny file-read-data (subpath ${quote(path)}))`,
    ),
    // Re-allow only the named read-only trees under protected state.
    ...profile.protectedReadRoots.map(
      (path) => `(allow file-read-data (subpath ${quote(path)}))`,
    ),
    // Re-allow only the writable roots under protected state.
    ...profile.writeRoots.map(
      (path) => `(allow file-read-data (subpath ${quote(path)}))`,
    ),
    '(deny file-read-data (regex #"/\\\\.env([^/]*$|/)"))',
    `(deny file-read-data (subpath ${quote(resolve(runtime, ".data"))}))`,
    `(deny file-read-data (subpath ${quote(resolve(runtime, "apps/server/.data"))}))`,
    // Deny access to the local control plane and its credential-bearing UI.
    ...controlNetworkRestrictions(profile.controlServerURL),
    "(deny file-write*)",
    '(allow file-write* (literal "/dev/null"))',
    ...profile.writeRoots.map(
      (path) => `(allow file-write* (subpath ${quote(path)}))`,
    ),
    ...[...profile.readOnlyDirectories, ...profile.readOnlyPaths].map(
      (path) => `(deny file-write* (subpath ${quote(canonical(path))}))`,
    ),
  ].join("\n");
  writeFileSync(profile.policyFile, rules, { mode: 0o600 });
  return {
    command: sandboxExec,
    args: ["-f", profile.policyFile, command, ...args],
  };
}

function offlineCommand(
  profile: OfflineCommandProfile,
  command: string,
  args: string[],
): SandboxLaunch {
  const rules = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read-metadata)",
    '(allow file-read-data (literal "/") (subpath "/private/etc") (subpath "/private/var/db"))',
    '(allow file-read-data (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
    '(allow file-write* (literal "/dev/null"))',
    ...[
      ...offlineCommandSystemRoots(),
      ...profile.readRoots,
      profile.writeRoot,
    ].map((path) => `(allow file-read-data (subpath ${quote(path)}))`),
    `(allow file-write* (subpath ${quote(profile.writeRoot)}))`,
    ...profile.readOnlyPaths.map(
      (path) => `(deny file-write* (subpath ${quote(path)}))`,
    ),
  ].join("\n");
  writeFileSync(profile.policyFile, rules, { mode: 0o600 });
  return {
    command: sandboxExec,
    args: ["-f", profile.policyFile, command, ...args],
  };
}

function loopbackService(
  profile: LoopbackServiceProfile,
  command: string,
  args: string[],
): SandboxLaunch {
  const rules = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read-metadata)",
    ...[
      "/usr",
      "/bin",
      "/System",
      "/Library",
      "/opt/homebrew",
      "/private/etc",
      "/private/var/db",
      ...profile.readRoots,
    ].map((path) => `(allow file-read-data (subpath ${quote(path)}))`),
    '(allow file-read-data (literal "/") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
    '(allow file-write* (literal "/dev/null"))',
    '(allow network-bind (local tcp "localhost:*"))',
    '(allow network-inbound (local tcp "localhost:*"))',
  ].join("\n");
  writeFileSync(profile.policyFile, rules, { mode: 0o400, flag: "wx" });
  return {
    command: sandboxExec,
    args: ["-f", profile.policyFile, command, ...args],
  };
}

export function darwinLauncher(
  profile: ReadonlyAgentProfile,
  command: string,
): string {
  const home = realpathSync(profile.home);
  const executable = isAbsolute(command)
    ? realpathSync(command)
    : (process.env.PATH ?? "")
        .split(delimiter)
        .map((root) => resolve(root, command))
        .filter(existsSync)
        .map((path) => realpathSync(path))[0];
  if (!executable) throw new SandboxError("executable_missing");
  const readRoots = profile.readRoots
    .filter(existsSync)
    .map((path) => realpathSync(path));
  const workdir = profile.workdir ? realpathSync(profile.workdir) : home;
  if (workdir !== home && !readRoots.some((root) => within(root, workdir)))
    throw new SandboxError("workdir_not_readable");
  // Beyond these roots: no source trees, global user config, project skills or
  // original materials. Only the private home is ever writable.
  const roots = [
    "/usr",
    "/bin",
    "/sbin",
    "/System",
    "/Library",
    "/opt/homebrew",
    "/private/etc",
    "/private/var/db",
    dirname(executable),
    home,
    ...readRoots,
  ];
  const rules = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read-metadata)",
    "(allow network-outbound)",
    "(allow network-bind)",
    '(allow file-read-data (literal "/") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
    ...roots.map((path) => `(allow file-read-data (subpath ${quote(path)}))`),
    '(allow file-write* (literal "/dev/null"))',
    `(allow file-write* (subpath ${quote(home)}))`,
    ...controlNetworkRestrictions(profile.controlServerURL),
  ].join("\n");
  const policyFile = resolve(home, "..", "verifier.sb");
  writeFileSync(policyFile, rules, { mode: 0o400, flag: "wx" });
  const wrapper = resolve(home, "..", "verifier-cli");
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    wrapper,
    `#!/bin/sh\ncd ${shellQuote(workdir)} || exit 1\nexec ${sandboxExec} -f ${shellQuote(policyFile)} ${shellQuote(executable)} "$@"\n`,
    { mode: 0o500, flag: "wx" },
  );
  return wrapper;
}
