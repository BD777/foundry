/**
 * The process may write only its writable roots. It never reads Foundry's
 * governance state; whether it reads the user's own files (home,
 * configuration, credentials, project .env files) is the profile's choice.
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
  /**
   * Programs the process runs besides the command itself, such as an agent
   * CLI; their install prefixes stay readable whatever else is hidden.
   */
  executables: string[];
  /**
   * `readable`: the user's files are readable, as in their own terminal.
   * `hidden`: only system roots, read roots and writable roots are.
   */
  userFiles: "readable" | "hidden";
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
}

/** No network; the process reads its read roots and writes one output root. */
export interface OfflineCommandProfile {
  kind: "offline_command";
  policyFile: string;
  workdir: string;
  readRoots: string[];
  writeRoot: string;
  /**
   * Further writable roots: the check's own candidate copy (new files only;
   * its tracked files stay read-only by permission), or a package store
   * while dependencies are prepared.
   */
  writeRoots?: string[];
  /** Paths inside the output root kept read-only. */
  readOnlyPaths: string[];
}

/**
 * The process may only serve local connections and read its read roots; it
 * writes nothing and reaches no network.
 */
export interface LoopbackServiceProfile {
  kind: "loopback_service";
  policyFile: string;
  readRoots: string[];
  /**
   * Private host directory for the service's Unix socket, used where the
   * service gets a network namespace of its own. Keep its path short: Unix
   * socket paths are limited to about 100 bytes.
   */
  socketDirectory: string;
}

/** Where a loopback service listens, and how the host reaches it. */
export type ServiceEndpoint =
  /** The service binds 127.0.0.1 on a free port and reports the port. */
  | { kind: "loopback_tcp" }
  /** The service listens at `servicePath`; the host connects at `hostPath`. */
  | { kind: "unix"; servicePath: string; hostPath: string };

export type SandboxProfile =
  | WritableTreeProfile
  | ReadonlyAgentProfile
  | OfflineCommandProfile
  | LoopbackServiceProfile;

export type SandboxKind = SandboxProfile["kind"];

export interface SandboxLaunch {
  command: string;
  args: string[];
  /** Set for `loopback_service`. */
  endpoint?: ServiceEndpoint;
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
  readonly kinds: readonly SandboxKind[];
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
