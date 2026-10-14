import { writeFileSync } from "node:fs";
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
import { sessionHasRunningBackgroundTasks } from "./runner/active-runtimes.js";
import { clearClaudeSettingsFiles } from "./session-policy.js";
import { readRegistry, recordExplicitWorkspace } from "./workspaces.js";
import { syncReviews } from "./issues.js";
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
import { superviseAgentProcesses } from "./agent-processes.js";
import { startSessionTimers } from "./session-timers.js";
import { logTime } from "./daemon/context.js";
import { runControlConnection } from "./daemon/control-connection.js";
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

/**
 * Record the server's removal decision locally and park the daemon. Called
 * from both the WS (4001 close) and polling (410 register) paths.
 */
async function stopAfterDeviceRemoval(serverURL: string): Promise<void> {
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
  // Agent processes die with this worker; those a previous one left
  // running stop before any work starts here.
  await superviseAgentProcesses();
  // Connector profiles a previous process wrote for its sessions.
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

  // Process-level heartbeat: write a timestamp file every 30s so an
  // external watchdog can detect event-loop blocks. The watchdog kills
  // the daemon if the file is stale (>5min), and launchd restarts it.
  const heartbeatPath = foundryStatePath("daemon-heartbeat");
  const writeHeartbeat = (): void => {
    try {
      writeFileSync(heartbeatPath, new Date().toISOString());
    } catch {
      // Best-effort — don't crash the daemon over a heartbeat write.
    }
  };
  writeHeartbeat();
  const heartbeatTimer = setInterval(writeHeartbeat, 30_000);
  startStallMonitor();
  // No Claude process from an earlier worker is left to read these.
  clearClaudeSettingsFiles();
  heartbeatTimer.unref();
  // The daemon's own folder may be gone (moved or renamed): it starts as
  // the device and reports that workspace missing.
  const startupWorkspacePath =
    workspacePath && workspaceFolderPresent(workspacePath) ? workspacePath : "";
  if (workspacePath && !startupWorkspacePath) noteMissingFolder(workspacePath);
  if (!(await registerAtStartup(serverURL, startupWorkspacePath))) return;
  // Timers of sessions no process of this worker runs, kept across restarts.
  if (!once) startSessionTimers(serverURL);
  if (startupWorkspacePath) await syncReviews(serverURL, startupWorkspacePath);
  const sessionTransport = new ReliableSessionTransport();
  const sessionExecutions = new SessionExecutionRegistry();
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
        sessionHasRunningBackgroundTasks(sessionId),
    );
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

    console.log(
      `${logTime()} Reconnecting in ${Math.round(backoffMs / 1000)}s...`,
    );
    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30000);
  }
}

/** Every message type the server sends a daemon, and the daemon's answer. */
export const daemonDispatch = new DaemonDispatch();
registerConnectionHandlers(daemonDispatch);
registerFileHandlers(daemonDispatch);
registerWorkspaceHandlers(daemonDispatch);
registerAgentHandlers(daemonDispatch);
registerDeviceHandlers(daemonDispatch);
registerSkillHandlers(daemonDispatch);
registerConnectorHandlers(daemonDispatch);
registerResourceHandlers(daemonDispatch);
registerSessionHandlers(daemonDispatch);
registerIssueHandlers(daemonDispatch);
