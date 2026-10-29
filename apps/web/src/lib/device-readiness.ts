import type {
  DeviceProfileBinding,
  DeviceProjection,
  DeviceServiceState,
  NativeCli,
  ProfileDefinition,
  ProviderHealth,
} from "@bd777/foundry-protocol";

export type AgentRuntime = "claude" | "codex";
export const agentRuntimes: readonly AgentRuntime[] = ["claude", "codex"];

/**
 * Where one agent runtime stands on a device, as its worker reports it plus
 * the installs this page started. Each state has exactly one action:
 * - unknown: not reported (offline, or a worker too old to say) — none;
 * - missing: Install;
 * - installing: none (progress);
 * - install_failed: Retry install;
 * - outdated: older than Foundry needs, Foundry-managed — Update now;
 * - updating: none (progress);
 * - external_update: the person's own copy with an update Foundry cannot
 *   apply — Switch to the Foundry-managed copy;
 * - ready: none.
 */
export type RuntimeReadinessState =
  | "unknown"
  | "missing"
  | "installing"
  | "install_failed"
  | "outdated"
  | "updating"
  | "external_update"
  | "ready";

export interface RuntimeInstallActivity {
  state: "running" | "succeeded" | "failed";
  startedAt: number;
  /** Why the request failed, or the installer's output. */
  detail?: string;
  log?: string;
  /** The program as the finished install left it. */
  cli?: NativeCli;
}

export interface RuntimeReadiness {
  runtime: AgentRuntime;
  state: RuntimeReadinessState;
  version?: string;
  /** The release an update would bring. */
  target?: string;
  /** Foundry keeps this copy up to date itself. */
  managed: boolean;
  /** Signed in to an official account (not needed for model providers). */
  signedIn: boolean;
  /** When the running install or update started (ms). */
  startedAt?: number;
  /** A failure's reason, in the worker's words. */
  detail?: string;
  log?: string;
  /** Model providers on this device that run on it. */
  assigned: number;
}

export interface DeviceReadiness {
  deviceId: string;
  online: boolean;
  owned: boolean;
  runtimes: Record<AgentRuntime, RuntimeReadiness>;
  memoryBytes?: number;
  /** Too little memory for Claude Code to run comfortably (never blocks). */
  lowMemory: boolean;
  /** The account the worker runs as. */
  user?: string;
  /** No swap at all (0 bytes reported); unknown counts as not. */
  noSwap: boolean;
  /** The worker's login service, as its worker last reported it. */
  service?: DeviceServiceState;
  /**
   * Whether the worker keeps running after the account logs out: "no" when
   * systemd reports linger off, "unknown" when it was not reported.
   */
  keepsRunning: "yes" | "no" | "unknown";
  /** The worker's processes stopped for lack of memory (last 7 days). */
  oomKills?: DeviceServiceState["oomKills"];
  /**
   * The Devices list's summary: installing while an install runs; needs
   * setup when nothing can run here, or an assigned provider's runtime is
   * missing or failed to install.
   */
  summary: "ready" | "installing" | "needs_setup" | "unknown";
}

/** Claude Code asks for 4 GB; a 4 GB machine reports a little less. */
const lowMemoryBytes = 3.5 * 1024 ** 3;

export function runtimeInstallKey(
  deviceId: string,
  runtime: AgentRuntime,
): string {
  return `${deviceId}\u0000${runtime}`;
}

function runtimeState(
  cli: NativeCli | undefined,
  install: RuntimeInstallActivity | undefined,
): Pick<
  RuntimeReadiness,
  "state" | "managed" | "startedAt" | "detail" | "log" | "target"
> {
  const update = cli?.update;
  const updateStarted = update?.checkedAt
    ? Date.parse(update.checkedAt)
    : undefined;
  if (install?.state === "running")
    return {
      state: cli?.installed ? "updating" : "installing",
      managed: false,
      startedAt: install.startedAt,
    };
  if (!cli) return { state: "unknown", managed: false };
  if (!cli.installed) {
    if (update?.state === "updating")
      return { state: "installing", managed: false, startedAt: updateStarted };
    if (install?.state === "failed" || update?.state === "failed")
      return {
        state: "install_failed",
        managed: false,
        detail:
          install?.state === "failed"
            ? (install.detail ?? update?.detail)
            : update?.detail,
        log: install?.state === "failed" ? install.log : undefined,
      };
    return { state: "missing", managed: false };
  }
  const external = update?.state === "external";
  const target = update?.target ?? cli.minimumVersion;
  if (update?.state === "updating")
    return {
      state: "updating",
      managed: !external,
      startedAt: updateStarted,
      target,
    };
  if (external) {
    const behind =
      cli.outdated ||
      Boolean(update?.target && update.current && update.current !== target);
    return {
      state: behind ? "external_update" : "ready",
      managed: false,
      target,
      detail: update?.detail,
    };
  }
  if (cli.outdated) return { state: "outdated", managed: true, target };
  return { state: "ready", managed: true };
}

/**
 * One device's readiness, from what its worker reports (provider health,
 * system) and the model providers assigned to it, plus the installs this
 * page started. Pure: every surface that shows readiness derives it here.
 */
export function deviceReadiness({
  device,
  providerHealth,
  bindings = [],
  profiles = [],
  installs,
}: {
  device: DeviceProjection;
  providerHealth: ProviderHealth[];
  bindings?: DeviceProfileBinding[];
  profiles?: Pick<ProfileDefinition, "id" | "runtime" | "authMode">[];
  installs?: ReadonlyMap<string, RuntimeInstallActivity>;
}): DeviceReadiness {
  const online = device.status === "connected";
  const assignedRuntimes = bindings
    .filter((row) => row.enabled && row.deviceId === device.id)
    .flatMap((row) => {
      const profile = profiles.find((item) => item.id === row.profileId);
      return profile && profile.authMode !== "official"
        ? [profile.runtime]
        : [];
    });
  const runtimes = Object.fromEntries(
    agentRuntimes.map((runtime) => {
      const health = providerHealth.find(
        (row) => row.provider === runtime && row.deviceId === device.id,
      );
      const install = installs?.get(runtimeInstallKey(device.id, runtime));
      // A finished install's answer is newer than a report not yet arrived.
      const cli =
        install?.state === "succeeded" && install.cli && !health?.cli?.installed
          ? install.cli
          : health?.cli;
      const state = runtimeState(cli, install);
      return [
        runtime,
        {
          runtime,
          ...state,
          version: cli?.installed ? cli.version : undefined,
          signedIn: health?.status === "healthy",
          assigned: assignedRuntimes.filter((value) => value === runtime)
            .length,
        } satisfies RuntimeReadiness,
      ];
    }),
  ) as Record<AgentRuntime, RuntimeReadiness>;
  const rows = agentRuntimes.map((runtime) => runtimes[runtime]);
  const memoryBytes = device.system?.memoryBytes;
  const service = device.system?.service;
  const keepsRunning: DeviceReadiness["keepsRunning"] =
    service?.manager === "systemd" && service.linger === false
      ? "no"
      : service?.linger === true || service?.manager === "launchd"
        ? "yes"
        : "unknown";
  const blocked = (row: RuntimeReadiness) =>
    row.state === "missing" || row.state === "install_failed";
  const summary: DeviceReadiness["summary"] = rows.some(
    (row) => row.state === "installing",
  )
    ? "installing"
    : rows.every((row) => row.state === "unknown")
      ? "unknown"
      : rows.every((row) => blocked(row) || row.state === "unknown") ||
          rows.some((row) => row.assigned > 0 && blocked(row))
        ? "needs_setup"
        : "ready";
  return {
    deviceId: device.id,
    online,
    owned: device.owned !== false,
    runtimes,
    memoryBytes,
    lowMemory: memoryBytes !== undefined && memoryBytes < lowMemoryBytes,
    user: device.system?.user,
    noSwap: device.system?.swapBytes === 0,
    service,
    keepsRunning,
    oomKills: service?.oomKills?.count ? service.oomKills : undefined,
    // A service that stops at logout takes the device away unannounced.
    summary:
      summary === "ready" && keepsRunning === "no" ? "needs_setup" : summary,
  };
}

export type DisconnectCause = "device_closed" | "network" | "server";

/**
 * Why the device's connection ended, in the terms people act on, from the
 * server's reason and the worker's own report (when it reconnected).
 * device_closed: the socket ended with no goodbye (1006 / unexpected EOF):
 * its worker stopped, or the machine shut down, slept or lost its network.
 * network: the connection went silent until it timed out.
 */
export function disconnectCause(
  device: Pick<DeviceProjection, "lastDisconnect">,
): DisconnectCause | undefined {
  const last = device.lastDisconnect;
  if (!last) return undefined;
  const closedBy = last.worker?.closedBy;
  if (closedBy === "network") return "network";
  if (closedBy === "worker") return "network";
  if (closedBy === "server") return "server";
  const reason = last.serverReason ?? "";
  if (/1006|unexpected EOF|\bEOF\b|connection reset|broken pipe/i.test(reason))
    return "device_closed";
  if (/timeout|timed out|deadline|no pong|ping/i.test(reason)) return "network";
  return undefined;
}

/** When an offline device went offline, as best known. */
export function offlineSince(
  device: Pick<DeviceProjection, "status" | "lastSeenAt" | "lastDisconnect">,
): string | undefined {
  if (device.status === "connected") return undefined;
  return device.lastDisconnect?.at ?? device.lastSeenAt;
}

/** The action a runtime's state offers, if any. */
export function runtimeAction(
  row: RuntimeReadiness,
): "install" | "retry" | "update" | "switch" | undefined {
  switch (row.state) {
    case "missing":
      return "install";
    case "install_failed":
      return "retry";
    case "outdated":
      return "update";
    case "external_update":
      return "switch";
    default:
      return undefined;
  }
}

/**
 * Which of `runtimes` assigning a model provider should install right away:
 * the missing (or failed) ones, on an online device this person owns.
 */
export function runtimesToInstall(
  readiness: DeviceReadiness,
  runtimes: readonly AgentRuntime[],
): AgentRuntime[] {
  if (!readiness.online || !readiness.owned) return [];
  return [...new Set(runtimes)].filter((runtime) =>
    ["missing", "install_failed"].includes(readiness.runtimes[runtime].state),
  );
}

/**
 * Why a model provider assigned to this device would not run there yet, as
 * a key under `readiness.assign` and its values; undefined when it would.
 */
export function assignmentNote(
  readiness: DeviceReadiness,
  runtime: AgentRuntime,
): "willInstall" | "installing" | "offline" | "notOwner" | undefined {
  const state = readiness.runtimes[runtime].state;
  if (state === "installing") return "installing";
  if (state !== "missing" && state !== "install_failed") return undefined;
  if (!readiness.owned) return "notOwner";
  if (!readiness.online) return "offline";
  return "willInstall";
}

/** "2 GiB" / "1.5 GiB": a device's memory, as people read it. */
export function memoryLabel(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return `${gib >= 10 ? Math.round(gib) : Math.round(gib * 10) / 10} GiB`;
}
