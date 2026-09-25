/**
 * Sandbox module: runs a process under an OS isolation policy.
 *
 * Callers describe paths and limits in a profile and use the same two calls
 * for every profile kind and every backend. The module selects the backend
 * (macOS Seatbelt, Linux bubblewrap), normalizes platform-independent inputs,
 * and fails closed with a typed SandboxError when no verified backend exists.
 * It knows nothing about who launches the process or why.
 * See docs/architecture-modules.md §5.1.
 */
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { within } from "../paths.js";
import { bubblewrapBackend } from "./linux.js";
import { seatbeltBackend } from "./darwin.js";
import {
  SandboxError,
  type ReadonlyAgentProfile,
  type SandboxBackend,
  type SandboxErrorCode,
  type SandboxGuarantees,
  type SandboxKind,
  type SandboxLaunch,
  type SandboxProfile,
} from "./types.js";

export {
  SandboxError,
  type LoopbackServiceProfile,
  type OfflineCommandProfile,
  type ReadonlyAgentProfile,
  type SandboxErrorCode,
  type SandboxGuarantees,
  type SandboxKind,
  type SandboxLaunch,
  type SandboxProfile,
  type WritableTreeProfile,
} from "./types.js";

const backends: Partial<Record<NodeJS.Platform, SandboxBackend>> = {
  darwin: seatbeltBackend,
  linux: bubblewrapBackend,
};

export function isSandboxError(
  error: unknown,
  code?: SandboxErrorCode,
): error is SandboxError {
  return (
    error instanceof SandboxError && (code === undefined || error.code === code)
  );
}

/**
 * What this platform's backend enforces for the kind, or undefined when no
 * verified backend exists. Static: a backend may still be missing at launch.
 */
export function sandboxGuarantees(
  kind: SandboxKind,
  platform: NodeJS.Platform = process.platform,
): SandboxGuarantees | undefined {
  return backends[platform]?.guarantees[kind];
}

export function sandboxAvailable(
  kind: SandboxKind,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return sandboxGuarantees(kind, platform) !== undefined;
}

/** The command line that runs `command` inside the profile. */
export function sandboxLaunch(
  profile: SandboxProfile,
  command: string,
  args: string[],
): SandboxLaunch {
  const prepared = prepare(profile, command);
  return prepared.backend.launch(prepared.profile, prepared.command, args);
}

/**
 * Write an executable wrapper that runs `command` inside the profile with the
 * wrapper's own arguments, for SDKs that take an executable path instead of a
 * command line. The wrapper is created once and never overwritten.
 */
export function sandboxLauncher(
  profile: SandboxProfile,
  command: string,
  launcherFile: string,
): string {
  const prepared = prepare(profile, command);
  const launch = prepared.backend.launch(
    prepared.profile,
    prepared.command,
    [],
  );
  const workdir = "workdir" in prepared.profile && prepared.profile.workdir;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    launcherFile,
    [
      "#!/bin/sh",
      ...(workdir ? [`cd ${quote(workdir)} || exit 1`] : []),
      `exec ${[launch.command, ...launch.args].map(quote).join(" ")} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o500, flag: "wx" },
  );
  return launcherFile;
}

function prepare(
  profile: SandboxProfile,
  command: string,
): { backend: SandboxBackend; profile: SandboxProfile; command: string } {
  const backend = backends[process.platform];
  if (!backend?.guarantees[profile.kind])
    throw new SandboxError(
      "unsupported_platform",
      `${profile.kind} isolation is not available on ${process.platform}`,
    );
  return profile.kind === "readonly_agent"
    ? { backend, ...readonlyAgent(profile, command) }
    : { backend, profile, command };
}

function readonlyAgent(
  profile: ReadonlyAgentProfile,
  command: string,
): { profile: ReadonlyAgentProfile; command: string } {
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
  return {
    profile: { ...profile, home, readRoots, workdir },
    command: executable,
  };
}
