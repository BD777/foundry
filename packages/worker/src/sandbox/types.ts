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
  /** Unix sockets outside the roots the process may connect to. */
  connectSockets: string[];
  /** The Foundry control plane to keep unreachable, where the backend can. */
  controlServerURL?: string;
}

/**
 * The process may read only system roots and its read roots, and may write
 * only its private home.
 */
export interface ReadonlyAgentProfile {
  kind: "readonly_agent";
  policyFile: string;
  home: string;
  readRoots: string[];
  /** Initial working directory inside a read root; defaults to the home. */
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

export type SandboxKind = SandboxProfile["kind"];

export interface SandboxLaunch {
  command: string;
  args: string[];
}

/** What a backend enforces for one profile kind, beyond files. */
export interface SandboxGuarantees {
  /** The Foundry control plane cannot be reached from inside. */
  controlPlaneBlocked: boolean;
}

/**
 * One isolation technology. The module selects the backend; callers never see
 * which one runs. Profiles arrive normalized: a `readonly_agent` command is an
 * absolute, resolved executable, and its home, read roots and workdir are
 * real paths with the workdir inside a read root or the home.
 */
export interface SandboxBackend {
  readonly id: string;
  /** Kinds this backend has verified implementations for. */
  readonly guarantees: Partial<Record<SandboxKind, SandboxGuarantees>>;
  launch(
    profile: SandboxProfile,
    command: string,
    args: string[],
  ): SandboxLaunch;
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
