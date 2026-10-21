import { resolve } from "node:path";
import WebSocket from "ws";
import type { RawData } from "ws";
import {
  daemonFeaturesHeader,
  daemonMessageTypes,
  parseProtocolEnvelopeJSON,
  registrationSectionsFeature,
  type ProtocolEnvelope,
} from "@bd777/foundry-protocol";
import { BackgroundOutputFollowers } from "../background-output-follow.js";
import {
  ConnectionRecorder,
  describeConnectionReport,
  watchServerSilence,
  withConnectionReports,
} from "../connection-reports.js";
import { readAgentRuntimeSettings } from "../device.js";
import { isDeviceRemovedSignal } from "../device-removal.js";
import { recordActivity } from "../diagnostics.js";
import { meterSocket } from "../send-meter.js";
import { stopAllEvidenceHTTPServices } from "../evidence-http-service.js";
import {
  coalescedIssueEnvironmentChanges,
  onIssueEnvironmentChange,
} from "../issue-environment-changes.js";
import { refreshOfficialSkills } from "../official-skills.js";
import { configuredAgentProfiles } from "../profiles.js";
import { providerHealthData } from "../provider-health.js";
import { closeAllActiveRuntimes } from "../runner/active-runtimes.js";
import { daemonRequestHeaders } from "../server-http.js";
import {
  clearOutOfBandSessionEventSink,
  setOutOfBandSessionEventSink,
  type SessionExecutionRegistry,
} from "../session-state.js";
import { beginActivity, duringActivity, withStalls } from "../stall-monitor.js";
import type { ConcurrentTaskScheduler } from "../task-scheduler.js";
import {
  sendWebSocket,
  trySendWebSocket,
  webSocketURL,
  type ReliableSessionTransport,
} from "../transport.js";
import { errorMessage, safeID } from "../utils.js";
import { workspaceFolderPresent } from "../workspace-registration.js";
import {
  availableDaemonCapabilities,
  recheckRunningNativeChats,
  syncNativeChats,
  withServedWorkspaces,
} from "../workspace-ops.js";
import {
  logTime,
  socketClosed,
  socketOpened,
  type ConnectionState,
  type DaemonContext,
  type SessionOutcome,
} from "./context.js";
import type { DaemonDispatch } from "./dispatch.js";
import { stopServingResources } from "./handlers/resources.js";
import { outOfBandEventSink } from "./session-execution.js";
import {
  noteMissingFolder,
  WorkspaceRoster,
  type WorkspaceRegistration,
} from "./workspace-roster.js";

const nativeChatSyncIntervalMs = 10000;

const providerCheckIntervalMs = 10 * 60 * 1000;

/** How often the worker tells the server it is there (see the heartbeat). */
const heartbeatIntervalMs = Number(
  process.env.FOUNDRY_HEARTBEAT_INTERVAL_MS || 25_000,
);

/** How often the socket and outbox are looked at for the connection report. */
const sendSampleMs = 1000;

/** Longest a closing connection waits for the server to take the outbox. */
const outboxSettleMs = 10_000;

/**
 * permessage-deflate for what the worker sends: registrations, scans and
 * session events are JSON that shrinks several times, and the uplink can be
 * slow and lossy. Messages under the threshold go as they are. No context
 * is kept between messages (the Go server supports no other mode), so the
 * connection holds one deflate and one inflate stream at most; zlib's
 * default window and memory level bound them to a few hundred KB. A server
 * that does not negotiate it gets plain frames.
 */
const perMessageDeflate = {
  clientNoContextTakeover: true,
  serverNoContextTakeover: true,
  threshold: 1024,
};

/** Longest the server may stay silent; it pings every 30s. */
const serverSilenceMs = Number(process.env.FOUNDRY_SERVER_SILENCE_MS || 75_000);

export interface ControlConnectionOptions {
  taskScheduler: ConcurrentTaskScheduler;
  idleTimeoutMs: number;
  once: boolean;
  sessionExecutions: SessionExecutionRegistry;
  sessionTransport: ReliableSessionTransport;
  serverURL: string;
  workspacePath: string;
}

/**
 * One control socket from connect to close; resolves with how it ended. The
 * messages that arrive on it are answered by `dispatch`.
 */
export function runControlConnection(
  options: ControlConnectionOptions,
  dispatch: DaemonDispatch,
): Promise<SessionOutcome> {
  return new Promise<SessionOutcome>((resolveSession, rejectSession) => {
    new ControlConnection(options, dispatch, resolveSession, rejectSession);
  });
}

/** Folders that are there, as registrations; one that cannot be read is skipped. */
function presentRegistrations(
  roster: WorkspaceRoster,
): WorkspaceRegistration[] {
  return roster
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
}

/**
 * A workspace's native chats; the first time on a connection its running
 * ones are rechecked as well (see recheckRunningNativeChats).
 */
async function syncWorkspaceNativeChats(
  serverURL: string,
  workspacePath: string,
  runningChatsRechecked: Set<string>,
): Promise<void> {
  try {
    await duringActivity("native chat sync", () =>
      syncNativeChats(serverURL, workspacePath),
    );
    if (!runningChatsRechecked.has(workspacePath)) {
      runningChatsRechecked.add(workspacePath);
      await recheckRunningNativeChats(serverURL, workspacePath).catch(
        (error: unknown) =>
          console.error(
            `Rechecking running native chats failed for ${workspacePath}: ${errorMessage(error)}`,
          ),
      );
    }
  } catch (error) {
    const message = errorMessage(error);
    console.error(`Native chat sync failed for ${workspacePath}: ${message}`);
  }
}

class ControlConnection {
  private readonly socket: WebSocket;
  private readonly connection = new ConnectionRecorder();
  private readonly stopSilenceWatch: () => void;
  private readonly roster: WorkspaceRoster;
  private readonly outputFollowers: BackgroundOutputFollowers;
  private readonly outOfBandSink: ReturnType<typeof outOfBandEventSink>;
  private readonly state: ConnectionState = {
    registered: false,
    refused: false,
    acceptedRun: false,
  };
  private readonly ctx: DaemonContext;
  private finished = false;
  private announcedIssueSlots = 1;
  private announcedCapabilities = "";
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private sendSampleTimer: NodeJS.Timeout | undefined;
  private workspaceRoundTimer: NodeJS.Timeout | undefined;
  private providerCheckTimer: NodeJS.Timeout | undefined;
  private nativeChatSyncPromise: Promise<void> | undefined;
  // Once per connection and workspace (see recheckRunningNativeChats).
  private readonly runningChatsRechecked = new Set<string>();
  private stopEnvironmentChanges: (() => void) | undefined;

  constructor(
    private readonly options: ControlConnectionOptions,
    private readonly dispatch: DaemonDispatch,
    private readonly resolveSession: (outcome: SessionOutcome) => void,
    private readonly rejectSession: (error: unknown) => void,
  ) {
    const socket = new WebSocket(webSocketURL(options.serverURL), {
      headers: daemonRequestHeaders(false),
      maxPayload: 2 * 1024 * 1024,
      handshakeTimeout: 30_000,
      perMessageDeflate,
    });
    this.socket = socket;
    socketOpened(socket);
    socket.on("upgrade", (response) =>
      this.connection.countBytes(response.socket),
    );
    // Without a single byte from the server for this long the socket is
    // ended and the loop reconnects; otherwise a connection dropped on the
    // way leaves the device offline while it thinks it is connected.
    this.stopSilenceWatch = watchServerSilence(socket, serverSilenceMs, () => {
      console.error(
        `${logTime()} Nothing from the server for ${serverSilenceMs / 1000}s; reconnecting.`,
      );
      this.connection.workerGaveUp();
      socket.terminate();
    });
    meterSocket(socket, this.connection.sends);
    socket.on("open", () => {
      this.connection.sends.opened();
      if (socket.extensions.includes("permessage-deflate"))
        this.connection.compressing();
      this.startHeartbeat();
      this.sendSampleTimer = setInterval(
        () =>
          this.connection.sends.sample(
            socket.bufferedAmount,
            options.sessionTransport.queuedCount(),
          ),
        sendSampleMs,
      );
      this.sendSampleTimer.unref();
    });
    socket.on("ping", () => this.connection.serverPing());
    socket.on("message", () => this.connection.serverData());
    this.roster = new WorkspaceRoster(
      socket,
      options.workspacePath,
      options.sessionExecutions,
    );
    // Background task logs read while they grow (see background-output-follow).
    this.outputFollowers = new BackgroundOutputFollowers({
      notify: (sessionId, taskId) =>
        trySendWebSocket(
          socket,
          daemonMessageTypes.backgroundTaskOutputChanged,
          { sessionId, taskId },
        ),
    });
    socket.on("upgrade", (response) => {
      const features = String(
        response.headers[daemonFeaturesHeader.toLowerCase()] ?? "",
      );
      this.roster.serverKeepsSections = features
        .split(",")
        .map((feature) => feature.trim())
        .includes(registrationSectionsFeature);
    });
    this.outOfBandSink = outOfBandEventSink(options.sessionTransport);
    this.ctx = this.context();
    socket.on("open", () => this.hello());
    socket.on("message", (data: RawData) => this.dispatchMessage(data));
    socket.on("close", (code?: number, reason?: Buffer) =>
      this.closed(code, reason),
    );
    socket.on("error", (error: Error) => {
      this.connection.socketError(error);
      if (!this.finished) {
        this.rejectSession(error);
      }
    });
  }

  /** The connection as the handlers of its messages see it. */
  private context(): DaemonContext {
    const { options } = this;
    return {
      socket: this.socket,
      serverURL: options.serverURL,
      workspacePath: options.workspacePath,
      once: options.once,
      idleTimeoutMs: options.idleTimeoutMs,
      taskScheduler: options.taskScheduler,
      sessionExecutions: options.sessionExecutions,
      sessionTransport: options.sessionTransport,
      roster: this.roster,
      outputFollowers: this.outputFollowers,
      state: this.state,
      finish: (outcome) => this.finish(outcome),
      announceAdditionalIssueCapacity: () =>
        this.announceAdditionalIssueCapacity(),
      checkProvidersAndReport: () => this.checkProvidersAndReport(),
      tellEnvironmentChanges: () => this.tellEnvironmentChanges(),
      routeOutOfBandEvents: () =>
        setOutOfBandSessionEventSink(this.outOfBandSink),
    };
  }

  // A heartbeat message every 25s, so the server hears from an idle worker
  // in an ordinary message as well as in pongs. (byte-dev's drops every
  // ~71s were not lost pongs: the server's read deadline moved only per
  // whole message, and a large upload on a slow link outlasted it while
  // the pongs queued behind it. The server now counts any bytes.)
  // It carries how far behind the session outbox is (see
  // ReliableSessionTransport); an older server ignores it.
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const capabilities = availableDaemonCapabilities().join("\n");
      if (capabilities !== this.announcedCapabilities) {
        this.announcedCapabilities = capabilities;
        this.reportDevice();
      }
      trySendWebSocket(this.socket, daemonMessageTypes.heartbeat, {
        outbox: this.options.sessionTransport.outboxStats(),
      });
    }, heartbeatIntervalMs);
  }

  /**
   * The hello lists every workspace this daemon serves; the rest follow as
   * workspace_ready, and the server marks the device's others unavailable.
   * A device with no workspace yet connects as itself; the person adds
   * workspaces from the Workspaces page.
   */
  private hello(): void {
    const { socket, roster, options } = this;
    this.announcedCapabilities = availableDaemonCapabilities().join("\n");
    const endRegistration = beginActivity("registration");
    const registrations = presentRegistrations(roster);
    const primary =
      registrations.find(
        (item) =>
          options.workspacePath &&
          item.workspace.localPath === resolve(options.workspacePath),
      ) ?? registrations[0];
    endRegistration();
    // Workspaces the device keeps whose folder is gone: named in the hello
    // apart from the served ones, and refused clearly until located.
    const reportedFolders = roster.helloFolders(registrations);
    for (const item of registrations) {
      roster.register(item);
    }
    const registration = primary ?? roster.deviceRegistration();
    console.log(
      primary
        ? `${logTime()} Connected daemon ${primary.device.label} to ${options.serverURL} for ${primary.workspace.name}`
        : `${logTime()} Connected daemon ${registration.device.label} to ${options.serverURL} (no workspace yet)`,
    );
    roster.sendRegistration(
      daemonMessageTypes.hello,
      withServedWorkspaces(
        withStalls(withConnectionReports(registration)),
        registrations,
        reportedFolders.missingWorkspaceIds,
      ),
      `hello_${Date.now()}`,
    );
    for (const item of registrations) {
      if (item.workspace.id === primary?.workspace.id) {
        continue;
      }
      roster.sendRegistration(
        daemonMessageTypes.workspaceReady,
        item,
        `workspace_ready_${safeID(item.workspace.id)}`,
      );
    }
    // Without a workspace, a folder that comes back is served from the next
    // round on.
    if (primary) this.syncKnownNativeChats();
    this.workspaceRoundTimer = setInterval(
      () => this.workspaceRound(),
      nativeChatSyncIntervalMs,
    );
    this.checkProvidersAndReport();
    this.providerCheckTimer = setInterval(
      () => this.checkProvidersAndReport(),
      providerCheckIntervalMs,
    );
  }

  // Every round: folders gone or back, then the native chats of those there.
  private workspaceRound(): void {
    this.roster.checkFolders();
    this.roster.checkContextFiles();
    this.syncKnownNativeChats();
  }

  private syncKnownNativeChats(): void {
    if (this.nativeChatSyncPromise) {
      return;
    }
    const syncStarted = Date.now();
    let syncedWorkspaces = 0;
    this.nativeChatSyncPromise = Promise.all(
      this.roster
        .knownPaths()
        .filter((workspacePath) => {
          if (workspaceFolderPresent(workspacePath)) return true;
          // A registered folder that is gone has nothing to sync; it is
          // logged once (see WorkspaceRoster.checkFolders).
          noteMissingFolder(workspacePath);
          return false;
        })
        .map((workspacePath) => {
          syncedWorkspaces += 1;
          return syncWorkspaceNativeChats(
            this.options.serverURL,
            workspacePath,
            this.runningChatsRechecked,
          );
        }),
    )
      .then(() => {
        recordActivity("nativeChatSync", syncStarted, {
          count: syncedWorkspaces,
        });
      })
      .finally(() => {
        this.nativeChatSyncPromise = undefined;
      });
  }

  private checkProvidersAndReport(): void {
    // The agents' own skills, read once per installed version: this also
    // catches a program installed or updated outside Foundry.
    void duringActivity("official skills", () => refreshOfficialSkills()).then(
      (changed) => {
        if (changed) this.reportDevice();
      },
    );
    // Never spend provider credentials on automatic inference health probes.
  }

  // The device's profiles, provider health or runtimes changed.
  private reportDevice(): void {
    if (this.finished || this.socket.readyState !== WebSocket.OPEN) return;
    const end = beginActivity("registration");
    try {
      this.roster.reportDevice();
    } finally {
      end();
    }
  }

  private announceAdditionalIssueCapacity(): void {
    const maxConcurrentTasks = readAgentRuntimeSettings().maxConcurrentTasks;
    while (this.announcedIssueSlots < maxConcurrentTasks) {
      this.announcedIssueSlots += 1;
      sendWebSocket(this.socket, daemonMessageTypes.readyForIssue);
    }
  }

  // Issue environment changes go to a server once it asks for them (a
  // status read with notifyChanges); older servers never do.
  private tellEnvironmentChanges(): void {
    if (this.stopEnvironmentChanges) return;
    const coalesced = coalescedIssueEnvironmentChanges((change) =>
      trySendWebSocket(
        this.socket,
        daemonMessageTypes.issueEnvironmentChanged,
        change,
      ),
    );
    const unsubscribe = onIssueEnvironmentChange(coalesced.listener);
    this.stopEnvironmentChanges = () => {
      unsubscribe();
      coalesced.close();
    };
  }

  private async dispatchMessage(data: RawData): Promise<void> {
    let envelope: ProtocolEnvelope;
    try {
      envelope = parseProtocolEnvelopeJSON(data.toString("utf8"));
    } catch (error) {
      const message = errorMessage(error);
      console.error(`Invalid server protocol message: ${message}`);
      this.socket.close(1002, "invalid protocol envelope");
      return;
    }
    await this.dispatch.dispatch(envelope, this.ctx);
  }

  private closed(code?: number, reason?: Buffer): void {
    const { options } = this;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.sendSampleTimer) clearInterval(this.sendSampleTimer);
    stopServingResources();
    this.outputFollowers.close();
    this.stopEnvironmentChanges?.();
    options.sessionTransport.unbind(this.socket);
    socketClosed(this.socket);
    const report = this.connection.closed(code, reason?.toString());
    console.log(
      `${logTime()} Daemon connection closed: ${describeConnectionReport(report)}.`,
    );
    if (isDeviceRemovedSignal({ code, reason: reason?.toString() })) {
      // Permanent server decision: park instead of backing off and
      // reconnecting. Local config is untouched pending an explicit repair.
      this.finish("removed");
      return;
    }
    if (this.state.refused && !options.once) {
      this.finish("refused");
      return;
    }
    if (!options.once) {
      // Agent sessions use the reconnectable outbox and keep running while
      // the control socket is replaced. Their task closure owns the old
      // scheduler until it completes.
      this.finish("reconnect");
      return;
    }
    closeAllActiveRuntimes();
    stopAllEvidenceHTTPServices();
    // Wait for in-flight tasks, but don't hang forever — a stuck task
    // should not wedge the entire reconnection lifecycle.
    const shutdownTimeout = new Promise<void>((resolve) =>
      setTimeout(resolve, 30_000),
    );
    Promise.race([options.taskScheduler.whenIdle(), shutdownTimeout])
      .then(() => this.finish("exit"))
      .catch((error: unknown) => this.rejectSession(error));
  }

  private finish(outcome: SessionOutcome): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.roster.close();
    this.stopSilenceWatch();
    if (this.state.idleTimer) {
      clearTimeout(this.state.idleTimer);
    }
    if (this.workspaceRoundTimer) {
      clearInterval(this.workspaceRoundTimer);
    }
    if (this.providerCheckTimer) clearInterval(this.providerCheckTimer);
    clearOutOfBandSessionEventSink(this.outOfBandSink);
    // A session's last messages may still wait in the outbox (--once
    // ends right after them): the server takes them before the socket
    // closes, for a bounded time. A closed socket waits for nothing.
    void this.options.sessionTransport.whenSettled(outboxSettleMs).then(() => {
      this.socket.close();
      this.resolveSession(outcome);
    });
  }
}
