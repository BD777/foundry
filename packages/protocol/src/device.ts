// Devices and the worker each runs: its build, updates, connections and
// diagnostics.

import type { DeviceAccountShare } from "./device-sharing.js";

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
  /**
   * Its owner turned off opening its files outside workspaces from chats;
   * the server adds it for the owner only. Absent: on.
   */
  outsideFilesOff?: boolean;
  /** Protocol features its worker declared; an older worker declares none. */
  capabilities?: string[];
  /**
   * The folders, resolved, the Personal Agent may create projects in
   * (setting personalAgent.managedRoots, default ~/Foundry); reported by a
   * worker that declared workspace_create.
   */
  managedRoots?: string[];
  /** The worker build it runs, reported at registration. */
  worker?: DeviceWorker;
  /** The machine, reported at registration. */
  system?: DeviceSystem;
  /** An update requested from Foundry that has not finished yet. */
  workerUpdate?: DeviceWorkerUpdate;
  /**
   * The worker's session runner (execution host), as its connection service
   * last reported it while connected; absent from older workers.
   */
  runner?: DeviceRunner;
  /** The last time the device dropped; the server adds it to projections. */
  lastDisconnect?: DeviceDisconnect;
  /**
   * When the server last recorded the device: for an offline one, when it
   * went offline. The server adds it (DEV-088).
   */
  lastSeenAt?: string;
  /**
   * Changes when the device's scanned skills or the catalog change. Workspace
   * data leaves skill lists out; load them with `/api/device-skills` and
   * reload when this changes.
   */
  skillsVersion?: string;
  /**
   * Other people's devices under the same system account of this computer:
   * they work with the same files and sign-ins. The server adds it, for the
   * device's owner only.
   */
  sharesSystemAccountWith?: DeviceAccountShare[];
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

/**
 * The session runner runs the agents; the connection service (daemon) talks
 * to the server. A new Worker restarts the connection service at once; the
 * runner switches only once its running turns end ("pending"): new turns
 * wait for the new runner, at most until the deadline. After it, they go to
 * the old runner again and it switches at the first moment no turn runs.
 * A turn is never stopped without the owner's "switch now".
 */
export interface DeviceRunner {
  /** The runner's own version; absent when it could not be read. */
  version?: string;
  /** The version it switches to: the connection service's. */
  targetVersion?: string;
  /** unavailable: it does not answer; the connection service reclaims it. */
  state: "current" | "pending" | "switching" | "failed" | "unavailable";
  /** A runner that stopped answering is being replaced. */
  reclaiming?: boolean;
  /** Since when it waits to switch (pending). */
  pendingSince?: string;
  /** Until when new turns wait for the new runner (pending). */
  deadline?: string;
  /** Turns the old runner is running now. */
  runningTurns: number;
  /** New turns waiting for the new runner. */
  heldTurns: number;
  /** Sessions with background tasks in the old runner. */
  backgroundSessions: number;
  /**
   * Pending past the deadline, or with only background work left: new turns
   * go to the old runner, which switches when nothing runs there.
   */
  waitingFor?: "turns" | "background";
  /** Why the last switch failed. */
  error?: string;
}

/** A turn a "switch now" would stop, as the owner reviews it. */
export interface DeviceRunnerTurn {
  sessionId: string;
  inputId?: string;
  /** The session's title, added by the server. */
  title?: string;
  workspaceId?: string;
  /** Only background tasks run for this session; no turn. */
  background?: boolean;
}

export interface DeviceRunnerDetail {
  runner?: DeviceRunner;
  turns: DeviceRunnerTurn[];
}

export type WorkerUpdateStep =
  | "starting"
  | "checking"
  | "downloading"
  | "installing"
  | "waiting"
  | "restarting";

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
  /**
   * What the worker sent in the first windowMs after the connection opened,
   * by message type, largest first (bytes of the uncompressed JSON; a large
   * message sent in pieces counts under its own type).
   */
  sentAfterOpen?: WorkerSentAfterOpen;
  /** Session outbox messages carried over from an earlier connection. */
  replayed?: WorkerSentCount;
  /** Most messages waiting in the session outbox, most bytes on the socket. */
  outboxPeak?: WorkerOutboxPeak;
  /** Longest the socket held bytes while the network took none of them. */
  longestSendStallMs?: number;
  /** Whether the connection compressed its messages (permessage-deflate). */
  compressed?: boolean;
}

/** A connection's first messages, by type (see sentAfterOpen). */
export interface WorkerSentAfterOpen {
  windowMs: number;
  types: WorkerSentCount[];
}

/** How many messages (of type) went, and their bytes. */
export interface WorkerSentCount {
  type?: string;
  count: number;
  bytes: number;
}

/** The fullest a worker's session outbox and socket got. */
export interface WorkerOutboxPeak {
  queued: number;
  bufferedBytes: number;
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
  | "forget-missing-workspaces"
  | "clear-skill-scan-cache"
  | "recheck-agents"
  | "install-bubblewrap";

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
  /** Swap space; absent where it is not a fixed size (macOS) or unreadable. */
  swapBytes?: number;
  /** How the worker is kept running there (DEV-088; 0.5.7 and later). */
  service?: DeviceServiceState;
}

/**
 * The login service that keeps the worker running, as the worker reads it
 * without administrator rights.
 */
export interface DeviceServiceState {
  manager: "systemd" | "launchd" | "none";
  /** The systemd unit or launchd label the worker installed. */
  unit?: string;
  installed: boolean;
  /**
   * systemd: whether the account's services keep running after it logs out
   * (`loginctl` Linger). Absent when it could not be read.
   */
  linger?: boolean;
  /** Where the worker writes its logs, as typed there (`~/.foundry/logs`). */
  logDir?: string;
  /**
   * The worker's own processes the kernel stopped for lack of memory in the
   * last 7 days, as far as this account can read (its user journal, else
   * its service's memory counters).
   */
  oomKills?: { count: number; lastAt?: string };
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
  /**
   * Turns the device runs at once. Saving 0 removes the owner's choice and
   * returns to the hardware default (DEV-084).
   */
  maxConcurrentTasks: number;
  /** Who chose it; workers before DEV-084 leave it out (the owner). */
  maxConcurrentTasksSource?: "owner" | "hardware";
  /** What this device's hardware allows by default. */
  hardwareMaxConcurrentTasks?: number;
  /** The memory and CPUs that default is computed from. */
  hardware?: { memoryGiB: number; cpus: number };
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
