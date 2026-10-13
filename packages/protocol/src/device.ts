// Devices and the worker each runs: its build, updates, connections and
// diagnostics.

export interface DeviceProjection {
  id: string;
  label: string;
  /**
   * "removed" is a server-side soft-removal tombstone projection. The device
   * row (and all history) is retained, but the UI hides it from the available
   * device list and the server refuses its daemon's (re)registration.
   */
  status: "connected" | "disconnected" | "removed";
  lastSeenLabel: string;
  runtimeSettings?: AgentRuntimeSettings;
  /** Whether the caller owns, and so may manage, this device. */
  owned?: boolean;
  /** What the device offers sessions, detected by its worker at registration. */
  resources?: DeviceResource[];
  /** Protocol features its worker declared; an older worker declares none. */
  capabilities?: string[];
  /** The worker build it runs, reported at registration (0.5.7 and later). */
  worker?: DeviceWorker;
  /** The machine, reported at registration (0.5.7 and later). */
  system?: DeviceSystem;
  /** An update requested from Foundry that has not finished yet. */
  workerUpdate?: DeviceWorkerUpdate;
  /** The last time the device dropped; the server adds it to projections. */
  lastDisconnect?: DeviceDisconnect;
  /**
   * Changes when the device's scanned skills or the catalog change. Workspace
   * data leaves skill lists out; load them with `/api/device-skills` and
   * reload when this changes.
   */
  skillsVersion?: string;
}

export interface DeviceWorkerUpdate {
  startedAt: string;
  /** The version it brings. */
  version?: string;
  /** The version the device ran when the update started. */
  fromVersion?: string;
  /** The file on the device the update writes to. */
  log?: string;
  /** The update did not finish in time; it may be started again. */
  stalled?: boolean;
  /** What it is doing, from the server's probes; after a failure, the last step seen. */
  step?: WorkerUpdateStep;
  /** What the step waits on, such as a retry. */
  stepDetail?: string;
  /** Why the update failed; it may be started again. */
  failure?: string;
  failureCode?: WorkerUpdateFailureCode;
  /** The failed update command's exit status. */
  exitCode?: number;
  /** The end of the update's log on the device, redacted. */
  logTail?: string[];
}

export type WorkerUpdateStep =
  "starting" | "checking" | "downloading" | "installing" | "restarting";

/**
 * `exited`: the update command failed. `vanished`: it ended without
 * reporting. `not_back`: the worker did not reconnect after restarting.
 */
export type WorkerUpdateFailureCode = "exited" | "vanished" | "not_back";

/**
 * A stretch when the worker's event loop was blocked; a registration carries
 * the ones recorded since the previous one so the server can log them.
 */
export interface WorkerStall {
  /** When the loop came back. */
  at: string;
  /** How long the loop was blocked, in milliseconds. */
  lagMs: number;
  /** The worker's long-running activities active during the stall. */
  activities?: string[];
}

/**
 * One connection to the server as the worker saw it, reported at the next
 * registration so a dropped device can be explained.
 */
export interface WorkerConnectionReport {
  openedAt: string;
  closedAt: string;
  /** How long the connection lasted, in milliseconds. */
  durationMs: number;
  /**
   * Who ended it: "worker" when the worker gave up (nothing from the server
   * for too long), "server" when a close frame arrived, "network" when the
   * socket ended without one.
   */
  closedBy: "worker" | "server" | "network";
  closeCode?: number;
  closeReason?: string;
  /** The socket error, e.g. "ECONNRESET: read ECONNRESET". */
  error?: string;
  /** Milliseconds between the last frame from the server and the close. */
  sinceServerDataMs?: number;
  /** Milliseconds between the server's last ping and the close. */
  sinceServerPingMs?: number;
  bytesReceived?: number;
  bytesSent?: number;
  /** Proxy host from the environment, if one is set (not used by the socket). */
  proxy?: string;
  /** Worst event-loop delay during the connection, in milliseconds. */
  maxLagMs?: number;
}

/** How a diagnostic check came out; "info" only reports a fact. */
export type DiagnosticStatus = "ok" | "info" | "warn" | "error";

/**
 * One check a worker ran on itself. The id names the check (the web words
 * its title and advice); values carry what it found.
 */
export interface DiagnosticCheck {
  id: string;
  status: DiagnosticStatus;
  values?: Record<string, string | number | boolean>;
}

/** A worker's report on itself, run on request from the device page. */
export interface DeviceDiagnostics {
  generatedAt: string;
  workerVersion: string;
  checks: DiagnosticCheck[];
  /** The worker's last connections to the server, oldest first. */
  connections: WorkerConnectionReport[];
  /** The end of the worker's own logs, secrets removed. */
  logTail: string[];
}

/** A repair a person can ask a worker to make on itself. */
export type DeviceRepairAction =
  "forget-missing-workspaces" | "clear-skill-scan-cache" | "recheck-agents";

export interface DeviceRepairResult {
  action: DeviceRepairAction;
  /** What changed, e.g. the forgotten folders. */
  values?: Record<string, string | number | boolean>;
}

/** The last time a device dropped, from both ends. */
export interface DeviceDisconnect {
  at: string;
  /** Why the server ended or lost the connection. */
  serverReason?: string;
  /** The worker's own account, once it reconnected and reported it. */
  worker?: WorkerConnectionReport;
}

/** The machine a device is, as its worker reports it at registration. */
export interface DeviceSystem {
  hostname: string;
  /** "macOS", "Debian GNU/Linux", … */
  os: string;
  osVersion?: string;
  kernel?: string;
  arch: string;
  cpuModel?: string;
  cpuCount?: number;
  memoryBytes?: number;
  /** The account the worker runs as. */
  user?: string;
  nodeVersion?: string;
}

export interface DeviceWorker {
  version: string;
  /**
   * The command that checks and updates the worker on that machine, as typed
   * there (`~/.foundry/bin/foundry-worker`); absent for a worker run from a
   * source checkout, which updates with git.
   */
  command?: string;
}

/**
 * A capability already present on a device that sessions may use, such as an
 * installed browser. Foundry discovers resources; it never installs them.
 */
export interface DeviceResource {
  /** Unique on the device, e.g. `browser:google-chrome`. */
  id: string;
  kind: "browser" | "computer_use";
  name: string;
  /** Whether a session can use it right now. */
  available: boolean;
  /** Why it is unavailable, or what a session should know about it. */
  detail?: string;
  /** Kind-specific facts, e.g. a browser's executable `path`. */
  attributes?: Record<string, string>;
}

export interface AgentRuntimeSettings {
  activeRuntimeTtlMs: number;
  maxConcurrentTasks: number;
}

/**
 * The npm package that installs a worker: `npx -y <name>@latest install`.
 * The web shows its commands; the worker installs and updates itself from it.
 */
export const workerPackageName = "@bd777/foundry-worker";

/**
 * Where a server's worker comes from (`GET /api/worker/release`): package
 * tarballs the server serves itself, at server-relative URLs, or the npm
 * registry. Workers install and update from it; the web shows commands for it.
 */
export type WorkerRelease =
  | { source: "npm" }
  | {
      source: "server";
      version: string;
      /**
       * `url` names this exact build (workers install from it); `latestUrl`
       * always serves the current one, so commands naming it stay valid.
       */
      packages: { name: string; url: string; latestUrl: string }[];
    };
