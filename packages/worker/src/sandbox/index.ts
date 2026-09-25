/**
 * Sandbox module: wraps a process in an OS isolation policy.
 *
 * Callers describe paths and limits in a profile; the module owns every
 * platform backend (macOS sandbox-exec, Linux bubblewrap) and fails closed
 * when no verified backend exists. It knows nothing about who launches the
 * process or why. See docs/architecture-modules.md §5.1.
 */
import { darwinLaunch, darwinLauncher } from "./darwin.js";
import { linuxLaunch } from "./linux.js";

/**
 * The process may read the host broadly, except protected Foundry and user
 * state, and may write only its writable roots.
 */
export interface WritableTreeProfile {
  kind: "writable_tree";
  /** Backend policy file; kept outside every writable root. */
  policyFile: string;
  workdir: string;
  readRoots: string[];
  writeRoots: string[];
  /** Read-only roots re-allowed inside otherwise protected host state. */
  protectedReadRoots: string[];
  /** Directories inside writable roots kept read-only; created when missing. */
  readOnlyDirectories: string[];
  /** Existing paths inside writable roots kept read-only. */
  readOnlyPaths: string[];
  /** The Foundry control plane stays unreachable from inside. */
  controlServerURL?: string;
}

/**
 * The process may read only system roots and its read roots, and may write
 * only its private home.
 */
export interface ReadonlyAgentProfile {
  kind: "readonly_agent";
  home: string;
  readRoots: string[];
  /** Initial working directory; defaults to the private home. */
  workdir?: string;
  controlServerURL?: string;
}

/** No network; the process reads its read roots and writes one output root. */
export interface OfflineCommandProfile {
  kind: "offline_command";
  policyFile: string;
  workdir: string;
  readRoots: string[];
  writeRoot: string;
  /** Paths inside the output root kept read-only. */
  readOnlyPaths: string[];
}

/** The process may only listen on loopback and read its read roots. */
export interface LoopbackServiceProfile {
  kind: "loopback_service";
  policyFile: string;
  readRoots: string[];
}

export type SandboxProfile =
  | WritableTreeProfile
  | ReadonlyAgentProfile
  | OfflineCommandProfile
  | LoopbackServiceProfile;

export type LaunchableProfile = Exclude<SandboxProfile, ReadonlyAgentProfile>;

export interface SandboxLaunch {
  command: string;
  args: string[];
}

export type SandboxErrorCode =
  | "unsupported_platform"
  | "backend_missing"
  | "user_namespaces_unavailable"
  | "executable_missing"
  | "workdir_not_readable";

export class SandboxError extends Error {
  constructor(
    readonly code: SandboxErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

export function isSandboxError(
  error: unknown,
  code?: SandboxErrorCode,
): error is SandboxError {
  return (
    error instanceof SandboxError && (code === undefined || error.code === code)
  );
}

const verifiedBackends: Record<
  SandboxProfile["kind"],
  readonly NodeJS.Platform[]
> = {
  writable_tree: ["darwin", "linux"],
  readonly_agent: ["darwin"],
  offline_command: ["darwin", "linux"],
  loopback_service: ["darwin"],
};

/** Whether this platform has a verified backend for the profile kind. */
export function sandboxAvailable(
  kind: SandboxProfile["kind"],
  platform: NodeJS.Platform = process.platform,
): boolean {
  return verifiedBackends[kind].includes(platform);
}

function requireBackend(kind: SandboxProfile["kind"]): void {
  if (!sandboxAvailable(kind))
    throw new SandboxError(
      "unsupported_platform",
      `${kind} isolation is not available on ${process.platform}`,
    );
}

/** The command and arguments that run `command` inside the profile. */
export function sandboxLaunch(
  profile: LaunchableProfile,
  command: string,
  args: string[],
): SandboxLaunch {
  requireBackend(profile.kind);
  return process.platform === "darwin"
    ? darwinLaunch(profile, command, args)
    : linuxLaunch(profile, command, args);
}

/**
 * An executable wrapper that runs `command` inside the profile, for SDKs that
 * take an executable path instead of a command line.
 */
export function sandboxLauncher(
  profile: ReadonlyAgentProfile,
  command: string,
): string {
  requireBackend(profile.kind);
  return darwinLauncher(profile, command);
}
