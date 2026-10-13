import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";
import type { RawData } from "ws";
import {
  daemonMessageTypes,
  parseProtocolEnvelopeJSON,
  type DeviceProjection,
  type ProtocolEnvelope,
} from "@bd777/foundry-protocol";
import { recordActivity } from "./diagnostics.js";
import { registerKnownSecret } from "./secret-redaction.js";
import {
  ConnectionRecorder,
  describeConnectionReport,
  watchServerSilence,
  withConnectionReports,
} from "./connection-reports.js";
import {
  beginActivity,
  duringActivity,
  startStallMonitor,
  withStalls,
} from "./stall-monitor.js";
import { startSessionScratchSweeps } from "./resource-pool.js";
import { adoptEarlierSessionScratch } from "./session-scratch-adoption.js";
import { workspaceFolderPresent } from "./workspace-registration.js";
import { readDaemonConfig, writeDaemonConfig } from "./config.js";
import { daemonRequestHeaders } from "./server-http.js";
import {
  ReliableSessionTransport,
  sendWebSocket,
  trySendWebSocket,
  webSocketURL,
} from "./transport.js";
import { ConcurrentTaskScheduler } from "./task-scheduler.js";
import {
  clearOutOfBandSessionEventSink,
  SessionExecutionRegistry,
  setOutOfBandSessionEventSink,
} from "./session-state.js";
import { configuredAgentProfiles } from "./profiles.js";
import { getDevice, readAgentRuntimeSettings } from "./device.js";
import {
  isDeviceRemovedSignal,
  parkAfterDeviceRemoval,
  readDeviceRemovedMarker,
  writeDeviceRemovedMarker,
} from "./device-removal.js";
import {
  closeAllActiveRuntimes,
  sessionHasRunningBackgroundTasks,
} from "./runner/active-runtimes.js";
import { BackgroundOutputFollowers } from "./background-output-follow.js";
import {
  coalescedIssueEnvironmentChanges,
  onIssueEnvironmentChange,
} from "./issue-environment-changes.js";
import { clearClaudeSettingsFiles } from "./session-policy.js";
import { refreshOfficialSkills } from "./official-skills.js";
import { checkDueProviders } from "./provider-check.js";
import { providerHealthData } from "./provider-health.js";
import { readRegistry, recordExplicitWorkspace } from "./workspaces.js";
import { syncReviews } from "./issues.js";
import {
  daemonWorkspacePath,
  explicitWorkspacePath,
  recheckRunningNativeChats,
  registerDaemon,
  serverURLFromArgs,
  syncNativeChats,
  withServedWorkspaces,
} from "./workspace-ops.js";
import { reapExternalAccountProfiles } from "./external-accounts.js";
import {
  errorMessage,
  optionEnabled,
  optionValue,
  safeID,
  sleep,
} from "./utils.js";
import { stopAllEvidenceHTTPServices } from "./evidence-http-service.js";
import { foundryStatePath } from "./state-root.js";
import { acquireDaemonLock } from "./device-pairing.js";
import { superviseAgentProcesses } from "./agent-processes.js";
import { startSessionTimers } from "./session-timers.js";
import {
  logTime,
  socketClosed,
  socketOpened,
  type ConnectionState,
  type DaemonContext,
  type SessionOutcome,
} from "./daemon/context.js";
import { DaemonDispatch } from "./daemon/dispatch.js";
import { registerAgentHandlers } from "./daemon/handlers/agents.js";
import { registerConnectionHandlers } from "./daemon/handlers/connection.js";
import { registerDeviceHandlers } from "./daemon/handlers/device.js";
import { registerFileHandlers } from "./daemon/handlers/files.js";
import { registerIssueHandlers } from "./daemon/handlers/issues.js";
import {
  registerResourceHandlers,
  stopServingResources,
} from "./daemon/handlers/resources.js";
import { registerSessionHandlers } from "./daemon/handlers/sessions.js";
import { registerSkillHandlers } from "./daemon/handlers/skills.js";
import { registerWorkspaceHandlers } from "./daemon/handlers/workspaces.js";
import { outOfBandEventSink } from "./daemon/session-execution.js";
import {
  noteMissingFolder,
  WorkspaceRoster,
  type WorkspaceRegistration,
} from "./daemon/workspace-roster.js";

const nativeChatSyncIntervalMs = 10000;

const providerCheckIntervalMs = 10 * 60 * 1000;

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
  // External-account profiles a previous process wrote for its sessions.
  reapExternalAccountProfiles({ log: (message) => console.error(message) });
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
      const outcome = await runWebSocketSession({
        idleTimeoutMs,
        once,
        sessionExecutions,
        taskScheduler,
        sessionTransport,
        serverURL,
        workspacePath,
      });
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

/** How often the worker tells the server it is there (see the heartbeat). */
const heartbeatIntervalMs = Number(
  process.env.FOUNDRY_HEARTBEAT_INTERVAL_MS || 25_000,
);

/** Longest a closing connection waits for the server to take the outbox. */
const outboxSettleMs = 10_000;

/** Longest the server may stay silent; it pings every 30s. */
const serverSilenceMs = Number(process.env.FOUNDRY_SERVER_SILENCE_MS || 75_000);

/** Every message type the server sends a daemon, and the daemon's answer. */
export const daemonDispatch = new DaemonDispatch();
registerConnectionHandlers(daemonDispatch);
registerFileHandlers(daemonDispatch);
registerWorkspaceHandlers(daemonDispatch);
registerAgentHandlers(daemonDispatch);
registerDeviceHandlers(daemonDispatch);
registerSkillHandlers(daemonDispatch);
registerResourceHandlers(daemonDispatch);
registerSessionHandlers(daemonDispatch);
registerIssueHandlers(daemonDispatch);

function runWebSocketSession(options: {
  taskScheduler: ConcurrentTaskScheduler;
  idleTimeoutMs: number;
  once: boolean;
  sessionExecutions: SessionExecutionRegistry;
  sessionTransport: ReliableSessionTransport;
  serverURL: string;
  workspacePath: string;
}): Promise<SessionOutcome> {
  return new Promise<SessionOutcome>((resolveSession, rejectSession) => {
    const socket = new WebSocket(webSocketURL(options.serverURL), {
      headers: daemonRequestHeaders(false),
      maxPayload: 2 * 1024 * 1024,
      handshakeTimeout: 30_000,
    });
    const connection = new ConnectionRecorder();
    socketOpened(socket);
    socket.on("upgrade", (response) => connection.countBytes(response.socket));
    // Without a single byte from the server for this long the socket is
    // ended and the loop reconnects; otherwise a connection dropped on the
    // way leaves the device offline while it thinks it is connected.
    const stopSilenceWatch = watchServerSilence(socket, serverSilenceMs, () => {
      console.error(
        `${logTime()} Nothing from the server for ${serverSilenceMs / 1000}s; reconnecting.`,
      );
      connection.workerGaveUp();
      socket.terminate();
    });
    // A heartbeat message every 25s, so the server hears from an idle worker
    // in an ordinary message as well as in pongs. (byte-dev's drops every
    // ~71s were not lost pongs: the server's read deadline moved only per
    // whole message, and a large upload on a slow link outlasted it while
    // the pongs queued behind it. The server now counts any bytes.)
    let heartbeatTimer: NodeJS.Timeout | undefined;
    // It carries how far behind the session outbox is (see
    // ReliableSessionTransport); an older server ignores it.
    socket.on("open", () => {
      heartbeatTimer = setInterval(
        () =>
          trySendWebSocket(socket, daemonMessageTypes.heartbeat, {
            outbox: options.sessionTransport.outboxStats(),
          }),
        heartbeatIntervalMs,
      );
    });
    socket.on("ping", () => connection.serverPing());
    socket.on("message", () => connection.serverData());
    const taskScheduler = options.taskScheduler;
    let announcedIssueSlots = 1;
    let finished = false;
    const state: ConnectionState = {
      registered: false,
      refused: false,
      acceptedRun: false,
    };
    let nativeChatSyncPromise: Promise<void> | undefined;
    let nativeChatSyncTimer: NodeJS.Timeout | undefined;
    let providerCheckTimer: NodeJS.Timeout | undefined;
    // Once per connection and workspace (see recheckRunningNativeChats).
    const runningChatsRechecked = new Set<string>();
    const roster = new WorkspaceRoster(
      socket,
      options.workspacePath,
      options.sessionExecutions,
    );
    // Background task logs read while they grow (see background-output-follow).
    const outputFollowers = new BackgroundOutputFollowers({
      notify: (sessionId, taskId) =>
        trySendWebSocket(
          socket,
          daemonMessageTypes.backgroundTaskOutputChanged,
          { sessionId, taskId },
        ),
    });
    // Issue environment changes go to a server once it asks for them (a
    // status read with notifyChanges); older servers never do.
    let stopEnvironmentChanges: (() => void) | undefined;
    function tellEnvironmentChanges(): void {
      if (stopEnvironmentChanges) return;
      const coalesced = coalescedIssueEnvironmentChanges((change) =>
        trySendWebSocket(
          socket,
          daemonMessageTypes.issueEnvironmentChanged,
          change,
        ),
      );
      const unsubscribe = onIssueEnvironmentChange(coalesced.listener);
      stopEnvironmentChanges = () => {
        unsubscribe();
        coalesced.close();
      };
    }

    const outOfBandSink = outOfBandEventSink(options.sessionTransport);

    function finish(outcome: SessionOutcome): void {
      if (finished) {
        return;
      }
      finished = true;
      roster.close();
      stopSilenceWatch();
      if (state.idleTimer) {
        clearTimeout(state.idleTimer);
      }
      if (nativeChatSyncTimer) {
        clearInterval(nativeChatSyncTimer);
      }
      if (providerCheckTimer) clearInterval(providerCheckTimer);
      clearOutOfBandSessionEventSink(outOfBandSink);
      // A session's last messages may still wait in the outbox (--once
      // ends right after them): the server takes them before the socket
      // closes, for a bounded time. A closed socket waits for nothing.
      void options.sessionTransport.whenSettled(outboxSettleMs).then(() => {
        socket.close();
        resolveSession(outcome);
      });
    }

    function announceAdditionalIssueCapacity(): void {
      const maxConcurrentTasks = readAgentRuntimeSettings().maxConcurrentTasks;
      while (announcedIssueSlots < maxConcurrentTasks) {
        announcedIssueSlots += 1;
        sendWebSocket(socket, daemonMessageTypes.readyForIssue);
      }
    }

    function syncKnownNativeChats(): void {
      if (nativeChatSyncPromise) {
        return;
      }
      const syncStarted = Date.now();
      let syncedWorkspaces = 0;
      nativeChatSyncPromise = Promise.all(
        roster
          .knownPaths()
          .filter((workspacePath) => {
            if (workspaceFolderPresent(workspacePath)) return true;
            // A registered folder that is gone has nothing to sync; it is
            // logged once (see WorkspaceRoster.checkFolders).
            noteMissingFolder(workspacePath);
            return false;
          })
          .map(async (workspacePath) => {
            syncedWorkspaces += 1;
            try {
              await duringActivity("native chat sync", () =>
                syncNativeChats(options.serverURL, workspacePath),
              );
              if (!runningChatsRechecked.has(workspacePath)) {
                runningChatsRechecked.add(workspacePath);
                await recheckRunningNativeChats(
                  options.serverURL,
                  workspacePath,
                ).catch((error: unknown) =>
                  console.error(
                    `Rechecking running native chats failed for ${workspacePath}: ${errorMessage(error)}`,
                  ),
                );
              }
            } catch (error) {
              const message = errorMessage(error);
              console.error(
                `Native chat sync failed for ${workspacePath}: ${message}`,
              );
            }
          }),
      )
        .then(() => {
          recordActivity("nativeChatSync", syncStarted, {
            count: syncedWorkspaces,
          });
        })
        .finally(() => {
          nativeChatSyncPromise = undefined;
        });
    }

    // Every round: folders gone or back, then the native chats of those there.
    function workspaceRound(): void {
      roster.checkFolders();
      syncKnownNativeChats();
    }

    socket.on("open", () => {
      const endRegistration = beginActivity("registration");
      const registrations = roster
        .knownPaths()
        .filter((workspacePath) => {
          if (workspaceFolderPresent(workspacePath)) return true;
          noteMissingFolder(workspacePath);
          return false;
        })
        .map((workspacePath) => {
          try {
            return roster.registration(workspacePath);
          } catch (error) {
            const message = errorMessage(error);
            console.error(`Skipping workspace ${workspacePath}: ${message}`);
            return undefined;
          }
        })
        .filter(
          (registration): registration is WorkspaceRegistration =>
            registration !== undefined,
        );
      const registration =
        registrations.find(
          (item) =>
            options.workspacePath &&
            item.workspace.localPath === resolve(options.workspacePath),
        ) ?? registrations[0];
      endRegistration();
      // Workspaces the device keeps whose folder is gone: named in the hello
      // apart from the served ones, and refused clearly until located.
      const reportedFolders = roster.helloFolders(registrations);
      if (!registration) {
        // A device with no workspace yet connects as itself; the person adds
        // workspaces from the Workspaces page.
        const device = roster.deviceRegistration();
        console.log(
          `${logTime()} Connected daemon ${device.device.label} to ${options.serverURL} (no workspace yet)`,
        );
        sendWebSocket(
          socket,
          daemonMessageTypes.hello,
          withServedWorkspaces(
            withStalls(withConnectionReports(device)),
            registrations,
            reportedFolders.missingWorkspaceIds,
          ),
        );
        // A folder that comes back is served from the next round on.
        nativeChatSyncTimer = setInterval(
          workspaceRound,
          nativeChatSyncIntervalMs,
        );
        checkProvidersAndReport();
        providerCheckTimer = setInterval(
          checkProvidersAndReport,
          providerCheckIntervalMs,
        );
        return;
      }
      for (const item of registrations) {
        roster.register(item);
      }
      console.log(
        `${logTime()} Connected daemon ${registration.device.label} to ${options.serverURL} for ${registration.workspace.name}`,
      );
      // The hello lists every workspace this daemon serves; the rest follow
      // as workspace_ready, and the server marks the device's others
      // unavailable.
      sendWebSocket(
        socket,
        daemonMessageTypes.hello,
        withServedWorkspaces(
          withStalls(withConnectionReports(registration)),
          registrations,
          reportedFolders.missingWorkspaceIds,
        ),
      );
      for (const item of registrations) {
        if (item.workspace.id === registration.workspace.id) {
          continue;
        }
        sendWebSocket(
          socket,
          daemonMessageTypes.workspaceReady,
          { registration: item },
          `workspace_ready_${safeID(item.workspace.id)}`,
        );
      }
      syncKnownNativeChats();
      nativeChatSyncTimer = setInterval(
        workspaceRound,
        nativeChatSyncIntervalMs,
      );
      checkProvidersAndReport();
      providerCheckTimer = setInterval(
        checkProvidersAndReport,
        providerCheckIntervalMs,
      );
    });

    // Providers found in the device's configuration are offered once a turn
    // through their SDK answered; a changed result re-reports every
    // workspace's registration, which carries the device's profiles.
    // Re-sends every workspace's registration, which carries the device's
    // profiles and runtimes, after something about them changed.
    function reportRegistrations(): void {
      if (finished || socket.readyState !== WebSocket.OPEN) return;
      const end = beginActivity("registration");
      try {
        reportEachRegistration();
      } finally {
        end();
      }
    }

    function reportEachRegistration(): void {
      for (const workspacePath of roster
        .knownPaths()
        .filter(workspaceFolderPresent)) {
        const registration = roster.registration(workspacePath);
        roster.register(registration);
        sendWebSocket(
          socket,
          daemonMessageTypes.workspaceReady,
          { registration },
          `registration_${safeID(registration.workspace.id)}_${Date.now()}`,
        );
      }
    }

    function checkProvidersAndReport(): void {
      // The agents' own skills, read once per installed version: this also
      // catches a program installed or updated outside Foundry.
      void duringActivity("official skills", () =>
        refreshOfficialSkills(),
      ).then((changed) => {
        if (changed) reportRegistrations();
      });
      void duringActivity("provider check", () =>
        checkDueProviders(
          configuredAgentProfiles(""),
          providerHealthData(),
          reportRegistrations,
        ),
      ).catch((error: unknown) =>
        console.error(`Checking providers failed: ${errorMessage(error)}`),
      );
    }

    const ctx: DaemonContext = {
      socket,
      serverURL: options.serverURL,
      workspacePath: options.workspacePath,
      once: options.once,
      idleTimeoutMs: options.idleTimeoutMs,
      taskScheduler,
      sessionExecutions: options.sessionExecutions,
      sessionTransport: options.sessionTransport,
      roster,
      outputFollowers,
      state,
      finish,
      announceAdditionalIssueCapacity,
      checkProvidersAndReport,
      tellEnvironmentChanges,
      routeOutOfBandEvents: () => setOutOfBandSessionEventSink(outOfBandSink),
    };

    socket.on("message", async (data: RawData) => {
      let envelope: ProtocolEnvelope;
      try {
        envelope = parseProtocolEnvelopeJSON(data.toString("utf8"));
      } catch (error) {
        const message = errorMessage(error);
        console.error(`Invalid server protocol message: ${message}`);
        socket.close(1002, "invalid protocol envelope");
        return;
      }
      await daemonDispatch.dispatch(envelope, ctx);
    });

    socket.on("close", (code?: number, reason?: Buffer) => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      stopServingResources();
      outputFollowers.close();
      stopEnvironmentChanges?.();
      options.sessionTransport.unbind(socket);
      socketClosed(socket);
      const report = connection.closed(code, reason?.toString());
      console.log(
        `${logTime()} Daemon connection closed: ${describeConnectionReport(report)}.`,
      );
      if (isDeviceRemovedSignal({ code, reason: reason?.toString() })) {
        // Permanent server decision: park instead of backing off and
        // reconnecting. Local config is untouched pending an explicit repair.
        finish("removed");
        return;
      }
      if (state.refused && !options.once) {
        finish("refused");
        return;
      }
      if (!options.once) {
        // Agent sessions use the reconnectable outbox and keep running while
        // the control socket is replaced. Their task closure owns the old
        // scheduler until it completes.
        finish("reconnect");
        return;
      }
      closeAllActiveRuntimes();
      stopAllEvidenceHTTPServices();
      // Wait for in-flight tasks, but don't hang forever — a stuck task
      // should not wedge the entire reconnection lifecycle.
      const shutdownTimeout = new Promise<void>((resolve) =>
        setTimeout(resolve, 30_000),
      );
      Promise.race([taskScheduler.whenIdle(), shutdownTimeout])
        .then(() => finish("exit"))
        .catch((error: unknown) => rejectSession(error));
    });

    socket.on("error", (error: Error) => {
      connection.socketError(error);
      if (!finished) {
        rejectSession(error);
      }
    });
  });
}
