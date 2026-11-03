import { startServerMcpForwarder } from "./platform/server-link/server-mcp-forwarder.js";
import { closeAllActiveRuntimes } from "./session/runner/active-runtimes.js";
import { sessionWork } from "./session-work/supervisor.js";
import { stopAllEvidenceHTTPServices } from "./issue/evidence/evidence-http-service.js";
import { queueEventImagePreviews } from "./daemon/attachment-previews.js";
import { registerNativeArchiveHandlers } from "./daemon/handlers/native-archive.js";
import { startAgentUpdates } from "./harness/agent-runtime/updates.js";
import {
  executionHostClient,
  startExecutionHost,
  stopExecutionHost,
} from "./execution-host/client.js";
import { writePrivateJSONAtomic } from "./platform/storage.js";
import { registerKnownSecret } from "./platform/secret-redaction.js";
import { startStallMonitor } from "./platform/stall-monitor.js";
import { startSessionScratchSweeps } from "./resources/resource-pool.js";
import { adoptEarlierSessionScratch } from "./session/session-scratch-adoption.js";
import { workspaceFolderPresent } from "./workspace/workspace-registration.js";
import { readDaemonConfig, writeDaemonConfig } from "./platform/config.js";
import { ReliableSessionTransport } from "./transport/transport.js";
import { ConcurrentTaskScheduler } from "./platform/task-scheduler.js";
import { SessionExecutionRegistry } from "./session/session-state.js";
import { getDevice, readAgentRuntimeSettings } from "./device/device.js";
import {
  parkAfterDeviceRemoval,
  readDeviceRemovedMarker,
  writeDeviceRemovedMarker,
} from "./device/device-removal.js";
import {
  sessionHasRunningBackgroundTasks,
  startIdleRuntimeSweeps,
} from "./session/runner/active-runtimes.js";
import { clearClaudeSettingsFiles } from "./session/session-launch-options.js";
import {
  readRegistry,
  recordExplicitWorkspace,
} from "./workspace/workspaces.js";
import {
  daemonWorkspacePath,
  explicitWorkspacePath,
  serverURLFromArgs,
} from "./daemon/workspace-ops.js";
import {
  reapConnectorLeftovers,
  startConnectorExtensions,
} from "./connectors/index.js";
import {
  errorMessage,
  optionEnabled,
  optionValue,
  sleep,
} from "./platform/utils.js";
import { foundryStatePath } from "./platform/state-root.js";
import { acquireDaemonLock } from "./device/device-pairing.js";
import {
  processIdentity,
  superviseAgentProcesses,
} from "./platform/process/agent-processes.js";
import { keepSessionTimers } from "./session/tasks/session-timers.js";
import { configureSessionTokens } from "./session/session-token.js";
import { startSessionWork } from "./daemon/session-work-runtime.js";
import { ownPackage } from "./install/worker-identity.js";
import { noteDaemonHealth } from "./daemon/daemon-health.js";
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
import { registerExtensionHandlers } from "./daemon/handlers/extensions.js";
import { registerWorkspaceHandlers } from "./daemon/handlers/workspaces.js";
import { noteMissingFolder } from "./daemon/workspace-roster.js";
import { exponentialBackoffMs } from "./platform/backoff.js";

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
 * Record the server's removal decision locally and park the daemon, as its
 * WebSocket was closed with 4001.
 */
async function stopAfterDeviceRemoval(serverURL: string): Promise<void> {
  await stopExecutionHost();
  // Without an execution host the turns, scheduled work and evidence
  // services run in this process: a removed device stops them too.
  sessionWork().stop();
  closeAllActiveRuntimes();
  stopAllEvidenceHTTPServices();
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
  // Installed connector extensions: model access they give, kept current.
  startConnectorExtensions(ownPackage().version);
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
  if (workspacePath && !workspaceFolderPresent(workspacePath))
    noteMissingFolder(workspacePath);
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

  // Consecutive reconnects without a session that ran.
  let reconnects = 0;
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
      if (outcome !== "refused") reconnects = 0;
    } catch (error) {
      const message = errorMessage(error);
      console.error(`${logTime()} Daemon connection failed: ${message}`);
      if (once) {
        throw error;
      }
    }

    const delayMs = reconnectDelayMs(
      exponentialBackoffMs(reconnects, 1000, 30000),
    );
    console.log(
      `${logTime()} Reconnecting in ${(delayMs / 1000).toFixed(1)}s...`,
    );
    await sleep(delayMs);
    reconnects += 1;
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
registerExtensionHandlers(daemonDispatch);
registerResourceHandlers(daemonDispatch);
registerSessionHandlers(daemonDispatch);
registerIssueHandlers(daemonDispatch);
