import { startServerMcpForwarder } from "./server-mcp-forwarder.js";
import { queueEventImagePreviews } from "./daemon/attachment-previews.js";
import { registerNativeArchiveHandlers } from "./daemon/handlers/native-archive.js";
import { startAgentUpdates } from "./agent-runtime/updates.js";
import {
  executionHostClient,
  startExecutionHost,
  stopExecutionHost,
} from "./execution-host/client.js";
import { writePrivateJSONAtomic } from "./storage.js";
import type { DeviceProjection } from "@bd777/foundry-protocol";
import { registerKnownSecret } from "./secret-redaction.js";
import { startStallMonitor } from "./stall-monitor.js";
import { startSessionScratchSweeps } from "./resource-pool.js";
import { adoptEarlierSessionScratch } from "./session-scratch-adoption.js";
import { workspaceFolderPresent } from "./workspace-registration.js";
import { readDaemonConfig, writeDaemonConfig } from "./config.js";
import { ReliableSessionTransport } from "./transport.js";
import { ConcurrentTaskScheduler } from "./task-scheduler.js";
import { SessionExecutionRegistry } from "./session-state.js";
import { getDevice, readAgentRuntimeSettings } from "./device.js";
import {
  isDeviceRemovedSignal,
  parkAfterDeviceRemoval,
  readDeviceRemovedMarker,
  writeDeviceRemovedMarker,
} from "./device-removal.js";
import {
  sessionHasRunningBackgroundTasks,
  startIdleRuntimeSweeps,
} from "./runner/active-runtimes.js";
import { clearClaudeSettingsFiles } from "./session-policy.js";
import { readRegistry, recordExplicitWorkspace } from "./workspaces.js";
import {
  daemonWorkspacePath,
  explicitWorkspacePath,
  registerDaemon,
  serverURLFromArgs,
} from "./workspace-ops.js";
import { reapConnectorLeftovers } from "./connectors/index.js";
import { errorMessage, optionEnabled, optionValue, sleep } from "./utils.js";
import { foundryStatePath } from "./state-root.js";
import { acquireDaemonLock } from "./device-pairing.js";
import { processIdentity, superviseAgentProcesses } from "./agent-processes.js";
import { keepSessionTimers } from "./session-timers.js";
import { configureSessionTokens } from "./session-token.js";
import { startSessionWork } from "./session-work/runtime.js";
import { ownPackage } from "./worker-identity.js";
import { noteDaemonHealth } from "./daemon-health.js";
import { logTime } from "./daemon/context.js";
import { runControlConnection } from "./daemon/control-connection.js";
import { registerServiceTunnelHandlers } from "./daemon/handlers/service-tunnels.js";
import { DaemonDispatch } from "./daemon/dispatch.js";
import { registerAgentHandlers } from "./daemon/handlers/agents.js";
import { registerConnectionHandlers } from "./daemon/handlers/connection.js";
import { registerDeviceHandlers } from "./daemon/handlers/device.js";
import { registerFileHandlers } from "./daemon/handlers/files.js";
import { registerIssueHandlers } from "./daemon/handlers/issues.js";
import { registerResourceHandlers } from "./daemon/handlers/resources.js";
import { registerSessionHandlers } from "./daemon/handlers/sessions.js";
import { registerSkillHandlers } from "./daemon/handlers/skills.js";
import { registerConnectorHandlers } from "./daemon/handlers/connectors.js";
import { registerWorkspaceHandlers } from "./daemon/handlers/workspaces.js";
import { noteMissingFolder } from "./daemon/workspace-roster.js";

let heartbeatStartTime: string | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Process-level heartbeat: a timestamp file every 30s from process start, so
 * an external watchdog can detect event-loop blocks (stale for over 5
 * minutes: it kills the daemon and its manager restarts it).
 */
function startDaemonHeartbeat(): void {
  const write = (): void => {
    try {
      writeDaemonHeartbeat();
    } catch {
      // Best-effort — don't crash the daemon over a heartbeat write.
    }
  };
  write();
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(write, 30_000);
  heartbeatTimer.unref();
}

function writeDaemonHeartbeat(): void {
  heartbeatStartTime ??= processIdentity(process.pid)?.startTime;
  writePrivateJSONAtomic(foundryStatePath("daemon-heartbeat"), {
    pid: process.pid,
    startTime: heartbeatStartTime,
    at: new Date().toISOString(),
  });
}

/**
 * Record the server's removal decision locally and park the daemon. Called
 * from both the WS (4001 close) and polling (410 register) paths.
 */
async function stopAfterDeviceRemoval(serverURL: string): Promise<void> {
  await stopExecutionHost();
  const device = getDevice();
  writeDeviceRemovedMarker({
    serverUrl: serverURL,
    deviceId: device.id,
    deviceLabel: device.label,
    removedAt: new Date().toISOString(),
  });
  const marker = readDeviceRemovedMarker();
  if (marker) {
    await parkAfterDeviceRemoval(marker);
  }
}

export async function connect(args: string[]): Promise<void> {
  // Automatic service starts must never resurrect a removed device or
  // reconnect-loop against the tombstone. Only an explicit pair/setup clears
  // this state.
  const removed = readDeviceRemovedMarker();
  if (removed) {
    await parkAfterDeviceRemoval(removed);
    return;
  }
  const existingConfig = readDaemonConfig();
  if (!existingConfig?.deviceCredential) {
    throw new Error(
      "This worker is not paired. In the Foundry web app open Devices → Add device, then run foundry-worker setup --token <token>.",
    );
  }
  registerKnownSecret(existingConfig.deviceCredential);
  acquireDaemonLock();
  // Startup grace begins before native/service discovery can take time,
  // and the heartbeat goes on while anything at startup waits.
  startDaemonHeartbeat();
  noteDaemonHealth({});
  // Reattach the OS-managed execution owner before reporting live claims.
  // The worker still supervises its own short-lived inspection processes.
  await startServerMcpForwarder(serverURLFromArgs(args));
  await startExecutionHost(serverURLFromArgs(args));
  await superviseAgentProcesses();
  // Connector profiles a previous process wrote for its sessions.
  if (!executionHostClient())
    reapConnectorLeftovers((message) => console.error(message));
  // A folder named with --workspace stays served after a restart without it.
  try {
    recordExplicitWorkspace(explicitWorkspacePath(args));
  } catch (error) {
    console.error(
      `Recording the --workspace folder failed: ${errorMessage(error)}`,
    );
  }
  writeDaemonConfig({
    ...existingConfig,
    serverURL: serverURLFromArgs(args),
    workspacePath: daemonWorkspacePath(args),
  });
  await connectWebSocket(args);
}

/**
 * Registers the workspace before anything reads it back: the server only
 * answers for workspaces it knows, so a freshly initialized folder must be
 * registered first. Returns undefined when the device was removed.
 */
async function registerAtStartup(
  serverURL: string,
  workspacePath: string,
): Promise<DeviceProjection | undefined> {
  try {
    return await registerDaemon(serverURL, workspacePath);
  } catch (error) {
    if (isDeviceRemovedSignal(errorMessage(error))) {
      await stopAfterDeviceRemoval(serverURL);
      return undefined;
    }
    throw error;
  }
}

async function connectWebSocket(args: string[]): Promise<void> {
  const serverURL = serverURLFromArgs(args);
  // "" until the device has a workspace: it connects without one.
  const workspacePath = daemonWorkspacePath(args);
  const once = optionEnabled(args, "--once");
  const idleTimeoutMs = Number(
    optionValue(args, "--idle-timeout-ms", once ? "2500" : "0"),
  );

  startDaemonHeartbeat();
  startStallMonitor();
  // No Claude process from an earlier worker is left to read these.
  if (!executionHostClient()) clearClaudeSettingsFiles();
  // The daemon's own folder may be gone (moved or renamed): it starts as
  // the device and reports that workspace missing.
  const startupWorkspacePath =
    workspacePath && workspaceFolderPresent(workspacePath) ? workspacePath : "";
  if (workspacePath && !startupWorkspacePath) noteMissingFolder(workspacePath);
  if (!(await registerAtStartup(serverURL, startupWorkspacePath))) return;
  if (!once && !executionHostClient()) {
    keepSessionTimers();
    configureSessionTokens(serverURL);
    await startSessionWork(serverURL, ownPackage().version);
  }
  const sessionTransport = new ReliableSessionTransport({
    onAcknowledged: (id) => executionHostClient()?.acknowledge(id),
    onEnqueued: (envelope) => queueEventImagePreviews(serverURL, envelope),
  });
  const sessionExecutions = new SessionExecutionRegistry();
  const host = executionHostClient();
  host?.attach(sessionTransport, sessionExecutions);
  if (host) {
    // An unanswering runner must not keep the device offline: the refresh
    // below retries it, and reclaims it when it is wedged.
    host.setHealthSink((runner, runnerDetail) =>
      noteDaemonHealth({ runner, runnerDetail }),
    );
    void host
      .refresh()
      .catch((error) =>
        console.error(`Execution host connection: ${errorMessage(error)}`),
      );
    const reconnectHost = setInterval(() => {
      if (executionHostClient() !== host) return;
      void host
        .refresh()
        .catch((error) =>
          console.error(`Execution host connection: ${errorMessage(error)}`),
        );
    }, 5000);
    reconnectHost.unref();
  }
  // Scratch directories of sessions idle too long, earlier runs' included;
  // those runs that kept no record had theirs adopted first.
  if (!once) {
    for (const { sessionId, adopted } of adoptEarlierSessionScratch([
      ...(workspacePath ? [workspacePath] : []),
      ...readRegistry().map((entry) => entry.path),
    ]))
      console.log(
        `Adopted the earlier scratch directories ${adopted.join(", ")} of session ${sessionId}`,
      );
    startSessionScratchSweeps(
      (sessionId) =>
        sessionExecutions.activeSessionIds().includes(sessionId) ||
        sessionHasRunningBackgroundTasks(sessionId) ||
        executionHostClient()?.hasSession(sessionId) === true,
    );
  }
  if (!once) {
    startAgentUpdates();
    if (!host) startIdleRuntimeSweeps();
  }
  const taskScheduler = new ConcurrentTaskScheduler(
    readAgentRuntimeSettings().maxConcurrentTasks,
  );

  let backoffMs = 1000;
  while (true) {
    try {
      const outcome = await runControlConnection(
        {
          idleTimeoutMs,
          once,
          sessionExecutions,
          taskScheduler,
          sessionTransport,
          serverURL,
          workspacePath,
        },
        daemonDispatch,
      );
      if (outcome === "removed") {
        // The server tombstoned this device. Park permanently; an explicit
        // pair/setup on this machine is the only way to register again.
        await stopAfterDeviceRemoval(serverURL);
        return;
      }
      if (outcome === "exit" || once) {
        return;
      }
      // A refused registration keeps backing off; a session that ran resets it.
      if (outcome !== "refused") backoffMs = 1000;
    } catch (error) {
      const message = errorMessage(error);
      console.error(`${logTime()} Daemon connection failed: ${message}`);
      if (once) {
        throw error;
      }
    }

    const delayMs = reconnectDelayMs(backoffMs);
    console.log(
      `${logTime()} Reconnecting in ${(delayMs / 1000).toFixed(1)}s...`,
    );
    await sleep(delayMs);
    backoffMs = Math.min(backoffMs * 2, 30000);
  }
}

/**
 * The wait before reconnecting: the backoff spread over half to one and a
 * half times its length. A server restart drops every device at once;
 * without the spread they would all reconnect in the same instant.
 */
export function reconnectDelayMs(
  backoffMs: number,
  random: () => number = Math.random,
): number {
  return Math.floor(backoffMs * (0.5 + random()));
}

/** Every message type the server sends a daemon, and the daemon's answer. */
export const daemonDispatch = new DaemonDispatch();
registerNativeArchiveHandlers(daemonDispatch);
registerConnectionHandlers(daemonDispatch);
registerServiceTunnelHandlers(daemonDispatch);
registerFileHandlers(daemonDispatch);
registerWorkspaceHandlers(daemonDispatch);
registerAgentHandlers(daemonDispatch);
registerDeviceHandlers(daemonDispatch);
registerSkillHandlers(daemonDispatch);
registerConnectorHandlers(daemonDispatch);
registerResourceHandlers(daemonDispatch);
registerSessionHandlers(daemonDispatch);
registerIssueHandlers(daemonDispatch);
