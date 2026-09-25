import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { existingWorkspaceFolder } from "./workspace-registration.js";
import { resolve } from "node:path";
import WebSocket from "ws";
import type { RawData } from "ws";
import {
  daemonMessageTypes,
  parseProtocolEnvelopeJSON,
  type AgentRuntimeSettings,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionEventMetadata,
  type DeviceProjection,
  type Issue,
  type SessionSkillRef,
  type ProfileDefinition,
  type ProfileAuthorization,
  type ProtocolEnvelope,
} from "@foundry/protocol";
import { readDaemonConfig, writeDaemonConfig } from "./config.js";
import {
  daemonRequestHeaders,
  ensureServerReachable,
  postJSON,
  ReliableSessionTransport,
  sendWebSocket,
  trySendWebSocket,
  webSocketURL,
  ReliableRunTransport,
} from "./transport.js";
import { ConcurrentTaskScheduler } from "./task-scheduler.js";
import {
  activeSessionCancelTargets,
  activeSessionSteerTargets,
  clearOutOfBandSessionEventSink,
  queuedSessionCancelRequests,
  SessionExecutionRegistry,
  setOutOfBandSessionEventSink,
  type OutOfBandSessionEvent,
} from "./session-state.js";
import {
  localProfileCredential,
  profileConfigForSession,
  withDispatchCredential,
  profileID,
  upsertAgentProfileConfig,
  type UpsertAgentProfilePayload,
} from "./profiles.js";
import {
  readAgentRuntimeSettings,
  writeAgentRuntimeSettings,
  devicePath,
  getDevice,
} from "./device.js";
import {
  isDeviceRemovedSignal,
  parkAfterDeviceRemoval,
  prepareExplicitRepair,
  readDeviceRemovedMarker,
  writeDeviceRemovedMarker,
} from "./device-removal.js";
import { closeAllActiveRuntimes } from "./runner.js";
import { runWorkspaceSession, type WorkspaceSandbox } from "./session/index.js";
import { issueSessionExecution } from "./issue-sessions.js";
import {
  packageSkillDirectory,
  readSkillTextFile,
  scanSkillRoots,
  toDeviceSkill,
} from "./skill-scanner.js";
import { materializeSessionSkills } from "./skill-materializer.js";
import { installService, serviceLogPaths, status } from "./service.js";
import {
  forgetWorkspaceRegistration,
  initWorkspace,
  readForgottenWorkspaces,
  readRegistry,
} from "./workspaces.js";
import {
  executeIssue,
  syncReviews,
  workspaceProjectionForPath,
} from "./issues.js";
import { listAgentModelsConfig } from "./models.js";
import { inspectNativeAccount } from "./native-inspection.js";
import {
  completeProfileAuthorization,
  reapAbandonedAuthorizations,
  startProfileAuthorization,
  stopProfileAuthorizations,
} from "./profile-authorization.js";
import {
  daemonRegistration,
  registerDaemon,
  serverURLFromArgs,
  sessionSchedulingKey,
  syncNativeChats,
  workspacePathFromArgs,
} from "./workspace-ops.js";
import {
  cancelActiveSession,
  createResponseStreamEventIDAllocator,
  createSessionStatusEventFilter,
  isAgentSessionCanceledError,
  registerActiveSessionSteerTarget,
  sendDirectoryListing,
  sendFileRead,
  sendSubagentList,
  sendSubagentTranscript,
  sendWorkspaceTreeListing,
  type ListWorkspaceTreePayload,
  sessionEvent,
  steerActiveSession,
  writeAgentSessionCompletionMarker,
} from "./session-helpers.js";
import {
  registerSessionAmbientEnv,
  type SessionAmbientEnv,
} from "./session-ambient.js";
import { optionEnabled, optionValue, safeID, sleep } from "./utils.js";
import { issueEnvironmentAction } from "./issue-environment-rpc.js";
import { evidenceWorkerAction } from "./evidence-rpc.js";
import { stopAllEvidenceHTTPServices } from "./evidence-http-service.js";
import type { EvidenceWorkerRequest } from "@foundry/protocol";
import { registerExecutionWorkspace } from "./repository-registry.js";
import { inspectWorkspace } from "./workspace-inspection.js";
import { readWorkspace } from "./workspaces.js";
import { recoverIssueRuns } from "./issue-recovery.js";
import { queuePreview, runIssuePreview } from "./issue-preview.js";
import { foundryStatePath } from "./state-root.js";
import { acquireDaemonLock, pairDevice } from "./device-pairing.js";

interface RunIssuePayload {
  issue: Issue;
  skillRefs?: SessionSkillRef[];
  /** Server decision: readable only for Issues the device owner started. */
  userFiles?: "readable" | "hidden";
}

interface ReadFilePayload {
  path: string;
  workspaceId: string;
}

interface ReadSubagentTranscriptPayload {
  sessionId: string;
  taskId: string;
  workspaceId: string;
}

interface ListSubagentsPayload {
  sessionId: string;
  workspaceId: string;
}

interface ListDirectoriesPayload {
  path: string;
}

interface SetupWorkspacePayload {
  path: string;
}

interface ForgetWorkspacePayload {
  path: string;
  workspaceId: string;
}

interface UpsertAgentRuntimeSettingsPayload {
  settings: AgentRuntimeSettings;
}

interface ListAgentModelsPayload {
  profile: UpsertAgentProfilePayload["profile"];
}

interface StartProfileAuthorizationPayload {
  profileId?: string;
  runtime?: string;
}

interface CompleteProfileAuthorizationPayload {
  authorizationResult?: string;
  flowId?: string;
}

interface ReadProfileCredentialPayload {
  profileId?: string;
}

interface RunSessionPayload {
  session: AgentSession;
  /** Server-held credential for the session's profile; memory-only. */
  credential?: string;
  /** One-time bearer token for the spawned agent's MCP/CLI surface. */
  sessionToken?: string;
  /**
   * Server-owned profile definition for this run. When present it is
   * authoritative and the local profiles file is not consulted, so a profile
   * that exists only in the control plane keeps its endpoint and knobs.
   */
  profile?: ProfileDefinition;
}

interface SteerSessionPayload {
  message?: string;
  sessionId?: string;
}

interface CancelSessionPayload {
  sessionId?: string;
}

const nativeChatSyncIntervalMs = 10000;

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
  acquireDaemonLock();
  writeDaemonConfig({
    ...existingConfig,
    serverURL: serverURLFromArgs(args),
    workspacePath: workspacePathFromArgs(args),
  });
  // A killed daemon can leave an agent CLI login running, and that login owns
  // the CLI's fixed callback port, so end the leftovers before anyone tries to
  // authorize again on this device.
  for (const runtime of ["claude", "codex"]) {
    reapAbandonedAuthorizations(runtime);
  }
  if (optionEnabled(args, "--polling")) {
    await connectPolling(args);
    return;
  }
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
    if (
      isDeviceRemovedSignal(
        error instanceof Error ? error.message : String(error),
      )
    ) {
      await stopAfterDeviceRemoval(serverURL);
      return undefined;
    }
    throw error;
  }
}

async function connectPolling(args: string[]): Promise<void> {
  const serverURL = serverURLFromArgs(args);
  const workspacePath = workspacePathFromArgs(args);
  const once = optionEnabled(args, "--once");
  const device = await registerAtStartup(serverURL, workspacePath);
  if (!device) return;
  const workspace = workspaceProjectionForPath(workspacePath, device);
  await syncNativeChats(serverURL, workspacePath);
  await syncReviews(serverURL, workspacePath);
  let lastNativeChatSyncAt = Date.now();

  while (true) {
    let issue: Issue | undefined;
    try {
      issue = await postJSON<Issue>(serverURL, "/api/daemon/issues/claim", {
        deviceId: device.id,
        workspaceId: workspace.id,
      });
    } catch (error) {
      if (
        isDeviceRemovedSignal(
          error instanceof Error ? error.message : String(error),
        )
      ) {
        await stopAfterDeviceRemoval(serverURL);
        return;
      }
      throw error;
    }
    if (!issue) {
      console.log("No ready issues available.");
      if (once) {
        return;
      }
      if (Date.now() - lastNativeChatSyncAt > nativeChatSyncIntervalMs) {
        await syncNativeChats(serverURL, workspacePath);
        lastNativeChatSyncAt = Date.now();
      }
      await sleep(2500);
      continue;
    }

    console.log(`Claimed ${issue.shortId}: ${issue.title}`);
    await executeIssue(serverURL, workspacePath, issue);
    await syncReviews(serverURL, workspacePath);
    if (once) {
      return;
    }
  }
}

async function connectWebSocket(args: string[]): Promise<void> {
  const serverURL = serverURLFromArgs(args);
  const workspacePath = workspacePathFromArgs(args);
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
  heartbeatTimer.unref();
  if (!(await registerAtStartup(serverURL, workspacePath))) return;
  await syncReviews(serverURL, workspacePath);
  const sessionTransport = new ReliableSessionTransport();
  for (const path of new Set([
    workspacePath,
    ...readRegistry().map((entry) => entry.path),
  ])) {
    try {
      await recoverIssueRuns(serverURL, path);
    } catch (error) {
      console.error(`Issue recovery for ${path}: ${String(error)}`);
    }
  }
  const sessionExecutions = new SessionExecutionRegistry();
  const taskScheduler = new ConcurrentTaskScheduler(
    readAgentRuntimeSettings().maxConcurrentTasks,
  );
  const activeIssues = new Set<string>();

  let backoffMs = 1000;
  while (true) {
    try {
      const outcome = await runWebSocketSession({
        idleTimeoutMs,
        once,
        sessionExecutions,
        taskScheduler,
        activeIssues,
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
      backoffMs = 1000;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Daemon connection failed: ${message}`);
      if (once) {
        throw error;
      }
    }

    console.log(`Reconnecting in ${Math.round(backoffMs / 1000)}s...`);
    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30000);
  }
}

/** Where a dispatched session runs and keeps its state. */
interface SessionExecution {
  /** Directory the agent works in. */
  cwd: string;
  /** Directory that receives Foundry's own session records. */
  stateRoot: string;
  sandbox?: WorkspaceSandbox;
}

// Chats run unsandboxed in the workspace itself; Issue-backed sessions run
// where and how the Issue decides.
function sessionExecution(
  rootPath: string,
  session: AgentSession,
  ambient: SessionAmbientEnv,
): SessionExecution {
  const issueId = session.issueId?.trim();
  return issueId
    ? issueSessionExecution(session.workspaceId, issueId, session.id, ambient)
    : { cwd: rootPath, stateRoot: rootPath };
}

async function executeAgentSession(
  transport: ReliableSessionTransport,
  execution: SessionExecution,
  session: AgentSession,
  dispatchCredential?: string,
  dispatchProfile?: ProfileDefinition,
  ambient?: SessionAmbientEnv,
): Promise<void> {
  const workspacePath = execution.cwd;
  const unregisterAmbient = ambient
    ? registerSessionAmbientEnv(session.id, ambient)
    : () => {};
  if (queuedSessionCancelRequests.delete(session.id)) {
    transport.send(daemonMessageTypes.sessionCompleted, {
      sessionId: session.id,
      error: "Session canceled before it started.",
    });
    unregisterAmbient();
    return;
  }
  const responseEventID = createResponseStreamEventIDAllocator(session.id);
  const shouldSendEvent = createSessionStatusEventFilter();
  const responseIntervalMs = 50;
  let lastResponseSentAt = 0;
  let pendingResponse:
    | {
        detail: string;
        level: AgentSessionEvent["level"];
        metadata?: AgentSessionEventMetadata;
        message?: AgentSessionEvent["message"];
      }
    | undefined;
  let responseTimer: ReturnType<typeof setTimeout> | undefined;
  const sendEvent = (
    label: string,
    detail: string,
    level: AgentSessionEvent["level"],
    metadata?: AgentSessionEventMetadata,
    message?: AgentSessionEvent["message"],
  ): void => {
    if (!shouldSendEvent({ label, detail, level, metadata })) {
      return;
    }
    const eventID = responseEventID(label, message?.id);
    transport.send(daemonMessageTypes.sessionEvent, {
      event: sessionEvent(
        session.id,
        label,
        detail,
        level,
        eventID,
        metadata,
        message,
      ),
    });
  };
  const flushPendingResponse = (): void => {
    if (responseTimer) {
      clearTimeout(responseTimer);
      responseTimer = undefined;
    }
    const pending = pendingResponse;
    pendingResponse = undefined;
    if (!pending) {
      return;
    }
    lastResponseSentAt = Date.now();
    sendEvent(
      "Response stream",
      pending.detail,
      pending.level,
      pending.metadata,
      pending.message,
    );
  };
  // A session waiting out a model rate-limit retry is blocked (active but
  // waiting), not running. Any other progress — including the next response
  // stream after the retry — clears the marker.
  let markedBlocked = false;
  const blockOnRateLimitLabels = new Set([
    "模型限流，等待重试",
    "模型请求重试",
  ]);

  const emit = async (
    label: string,
    detail: string,
    level: AgentSessionEvent["level"] = "info",
    metadata?: AgentSessionEventMetadata,
    message?: AgentSessionEvent["message"],
  ): Promise<void> => {
    const retrying = level === "warning" && blockOnRateLimitLabels.has(label);
    if (retrying && !markedBlocked) {
      markedBlocked = true;
      transport.send(daemonMessageTypes.sessionBlocked, {
        sessionId: session.id,
        reason: label,
      });
    } else if (!retrying && markedBlocked) {
      markedBlocked = false;
      transport.send(daemonMessageTypes.sessionResumed, {
        sessionId: session.id,
      });
    }
    if (label === "Response stream") {
      if (
        pendingResponse?.message?.id &&
        message?.id &&
        pendingResponse.message.id !== message.id
      )
        flushPendingResponse();
      pendingResponse = { detail, level, metadata, message };
      const elapsed = Date.now() - lastResponseSentAt;
      if (elapsed >= responseIntervalMs) {
        flushPendingResponse();
      } else if (!responseTimer) {
        responseTimer = setTimeout(
          flushPendingResponse,
          responseIntervalMs - elapsed,
        );
      }
      return;
    }
    flushPendingResponse();
    sendEvent(label, detail, level, metadata, message);
  };

  const reportedNativeSessionIds = new Set<string>();
  const reportNativeSessionId = (nativeSessionId: string): void => {
    const trimmed = nativeSessionId?.trim();
    if (!trimmed || reportedNativeSessionIds.has(trimmed)) {
      return;
    }
    reportedNativeSessionIds.add(trimmed);
    transport.send(daemonMessageTypes.sessionNativeSessionId, {
      sessionId: session.id,
      nativeSessionId: trimmed,
    });
  };

  transport.send(daemonMessageTypes.sessionStarted, {
    sessionId: session.id,
  });
  const unregisterUnsupportedCodexSteer =
    session.provider === "codex"
      ? registerActiveSessionSteerTarget(session.id, {
          provider: "codex",
          steer: async () => {
            throw new Error(
              "Codex SDK does not support steering the active turn yet. Keep it queued for the next turn.",
            );
          },
        })
      : undefined;
  try {
    const profile = withDispatchCredential(
      profileConfigForSession(workspacePath, session, dispatchProfile),
      dispatchCredential,
    );
    let setupEmitted = false;
    const emitSetup = async (): Promise<void> => {
      if (setupEmitted) {
        return;
      }
      setupEmitted = true;
      await emit("Loaded workspace", workspacePath);
      await emit(
        "Selected profile",
        `${profile.label ?? profileID(profile)} · ${profile.connectionType ?? "local_login"}`,
      );
    };
    // Resolve the workspace-selected skills into a managed runtime tree before
    // the agent starts. An empty selection materializes an empty allowlist,
    // which the runner enforces as "expose nothing".
    const managedSkills = await materializeSessionSkills(
      session.skillRefs ?? [],
      ambient?.serverURL ?? "",
      workspacePath,
    );
    if (managedSkills.skills.length > 0) {
      await emit(
        "Loaded skills",
        managedSkills.skills.map((skill) => skill.name).join(", "),
      );
    }
    // Session liveness is carried by the process-scoped execution claim on
    // the daemon connection. Do not manufacture visible transcript events
    // when the provider has produced no actual progress or response content.
    const result = await runWorkspaceSession({
      cwd: execution.cwd,
      session,
      profile,
      managedSkills,
      emit,
      emitSetup,
      reportNativeSessionId,
      sandbox: execution.sandbox,
    });
    flushPendingResponse();
    writeAgentSessionCompletionMarker(execution.stateRoot, session, result);
    transport.send(daemonMessageTypes.sessionCompleted, {
      sessionId: session.id,
      nativeSessionId: result.nativeSessionId,
      response: result.response,
    });
  } catch (error) {
    if (isAgentSessionCanceledError(error)) {
      await emit("Session canceled", "Canceled by user.", "warning");
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    await emit("Session failed", message, "error");
    transport.send(daemonMessageTypes.sessionCompleted, {
      sessionId: session.id,
      error: message,
    });
  } finally {
    flushPendingResponse();
    unregisterAmbient();
    unregisterUnsupportedCodexSteer?.();
    activeSessionSteerTargets.delete(session.id);
    activeSessionCancelTargets.delete(session.id);
  }
}

function daemonRegistrationWithActiveSessions(
  workspacePath: string,
  sessionExecutions: SessionExecutionRegistry,
): ReturnType<typeof daemonRegistration> & { activeSessionIds: string[] } {
  return {
    ...daemonRegistration(workspacePath),
    // This is an execution claim, not device presence. It survives a socket
    // reconnect because the registry is process-scoped, but it is empty after
    // a daemon restart so a replacement process cannot keep orphaned work
    // alive merely by registering the same device ID.
    activeSessionIds: sessionExecutions.activeSessionIds(),
  };
}

type sessionOutcome = "exit" | "reconnect" | "removed";

function runWebSocketSession(options: {
  taskScheduler: ConcurrentTaskScheduler;
  activeIssues: Set<string>;
  idleTimeoutMs: number;
  once: boolean;
  sessionExecutions: SessionExecutionRegistry;
  sessionTransport: ReliableSessionTransport;
  serverURL: string;
  workspacePath: string;
}): Promise<sessionOutcome> {
  return new Promise<sessionOutcome>((resolveSession, rejectSession) => {
    const socket = new WebSocket(webSocketURL(options.serverURL), {
      headers: daemonRequestHeaders(false),
      maxPayload: 2 * 1024 * 1024,
    });
    const taskScheduler = options.taskScheduler;
    let announcedIssueSlots = 1;
    let acceptedRun = false;
    let finished = false;
    let idleTimer: NodeJS.Timeout | undefined;
    let nativeChatSyncPromise: Promise<void> | undefined;
    let nativeChatSyncTimer: NodeJS.Timeout | undefined;
    const workspacePaths = new Map<string, string>();

    // Timer-driven background turns arrive while no Foundry turn is active.
    // They cross the socket as ordinary session_event envelopes, which the
    // server persists and broadcasts like turn-scoped events.
    const outOfBandSink = (
      sessionId: string,
      partial: OutOfBandSessionEvent,
    ): void => {
      options.sessionTransport.send(daemonMessageTypes.sessionEvent, {
        event: sessionEvent(
          sessionId,
          partial.label,
          partial.detail,
          partial.level ?? "info",
          undefined,
          partial.metadata,
          partial.message,
        ),
      });
    };

    function registerWorkspacePath(
      registration: ReturnType<typeof daemonRegistration>,
    ): void {
      workspacePaths.set(
        registration.workspace.id,
        registration.workspace.localPath,
      );
    }

    function unregisterWorkspacePath(
      workspaceId: string,
      workspacePath: string,
    ): void {
      const normalizedPath = workspacePath ? resolve(workspacePath) : "";
      if (workspaceId) {
        workspacePaths.delete(workspaceId);
      }
      if (normalizedPath) {
        for (const [id, path] of [...workspacePaths.entries()]) {
          if (resolve(path) === normalizedPath) {
            workspacePaths.delete(id);
          }
        }
      }
    }

    function workspacePathFor(workspaceId: string): string {
      const workspacePath = workspacePaths.get(workspaceId);
      if (!workspacePath) {
        throw new Error(
          `workspace ${workspaceId} is not registered in this local daemon`,
        );
      }
      return workspacePath;
    }

    function knownWorkspacePaths(): string[] {
      const forgotten = readForgottenWorkspaces();
      const paths = [
        resolve(options.workspacePath),
        ...readRegistry().map((entry) => resolve(entry.path)),
      ];
      return [...new Set(paths)].filter(
        (workspacePath) =>
          !forgotten.some(
            (entry) =>
              resolve(entry.path) === workspacePath ||
              (entry.id && workspacePaths.get(entry.id) === workspacePath),
          ),
      );
    }

    function finish(outcome: sessionOutcome): void {
      if (finished) {
        return;
      }
      finished = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      if (nativeChatSyncTimer) {
        clearInterval(nativeChatSyncTimer);
      }
      clearOutOfBandSessionEventSink(outOfBandSink);
      socket.close();
      resolveSession(outcome);
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
      nativeChatSyncPromise = Promise.all(
        knownWorkspacePaths().map(async (workspacePath) => {
          try {
            await syncNativeChats(options.serverURL, workspacePath);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            console.error(
              `Native chat sync failed for ${workspacePath}: ${message}`,
            );
          }
        }),
      )
        .then(() => undefined)
        .finally(() => {
          nativeChatSyncPromise = undefined;
        });
    }

    socket.on("open", () => {
      const registrations = knownWorkspacePaths()
        .map((workspacePath) => {
          try {
            return daemonRegistrationWithActiveSessions(
              workspacePath,
              options.sessionExecutions,
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            console.error(`Skipping workspace ${workspacePath}: ${message}`);
            return undefined;
          }
        })
        .filter(
          (
            registration,
          ): registration is ReturnType<
            typeof daemonRegistrationWithActiveSessions
          > => registration !== undefined,
        );
      const registration =
        registrations.find(
          (item) => item.workspace.localPath === resolve(options.workspacePath),
        ) ?? registrations[0];
      if (!registration) {
        socket.close();
        rejectSession(
          new Error("No local Foundry workspace can be registered."),
        );
        return;
      }
      for (const item of registrations) {
        registerWorkspacePath(item);
      }
      console.log(
        `Connected daemon ${registration.device.label} to ${options.serverURL} for ${registration.workspace.name}`,
      );
      sendWebSocket(socket, daemonMessageTypes.hello, registration);
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
        syncKnownNativeChats,
        nativeChatSyncIntervalMs,
      );
    });

    socket.on("message", async (data: RawData) => {
      let envelope: ProtocolEnvelope;
      try {
        envelope = parseProtocolEnvelopeJSON(data.toString("utf8"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Invalid server protocol message: ${message}`);
        socket.close(1002, "invalid protocol envelope");
        return;
      }
      if (envelope.type === daemonMessageTypes.error) {
        console.error(
          `Server error: ${envelope.error ?? "unknown websocket error"}`,
        );
        return;
      }
      if (envelope.type === daemonMessageTypes.ack) {
        options.sessionTransport.acknowledge(envelope.id);
        return;
      }
      if (envelope.type === daemonMessageTypes.registered) {
        options.sessionTransport.bind(socket);
        // Timer-driven background turns arrive while no Foundry turn is
        // active; route their events over this socket as ordinary
        // session_event envelopes the server persists and broadcasts.
        setOutOfBandSessionEventSink(outOfBandSink);
        announceAdditionalIssueCapacity();
        if (options.once && options.idleTimeoutMs > 0) {
          idleTimer = setTimeout(() => finish("exit"), options.idleTimeoutMs);
        }
        return;
      }
      if (envelope.type === daemonMessageTypes.readFile) {
        const payload = envelope.payload as ReadFilePayload | undefined;
        if (!payload?.path) {
          console.error("Received read_file without a path payload.");
          return;
        }
        try {
          sendFileRead(
            socket,
            envelope.id,
            workspacePathFor(payload.workspaceId),
            payload,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          sendWebSocket(
            socket,
            daemonMessageTypes.fileRead,
            {
              workspaceId: payload.workspaceId,
              path: payload.path,
              content: "",
              truncated: false,
              error: message,
            },
            envelope.id,
          );
        }
        return;
      }
      if (envelope.type === daemonMessageTypes.readSubagentTranscript) {
        const payload = envelope.payload as
          ReadSubagentTranscriptPayload | undefined;
        if (!payload?.workspaceId || !payload.sessionId || !payload.taskId) {
          sendWebSocket(
            socket,
            daemonMessageTypes.subagentTranscriptRead,
            {
              sessionId: payload?.sessionId ?? "",
              taskId: payload?.taskId ?? "",
              title: "Subagent",
              toolUseId: "",
              status: "failed",
              messages: [],
              error: "workspaceId, sessionId, and taskId are required",
            },
            envelope.id,
          );
          return;
        }
        sendSubagentTranscript(
          socket,
          envelope.id,
          workspacePathFor(payload.workspaceId),
          payload,
        );
        return;
      }
      if (envelope.type === daemonMessageTypes.listSubagents) {
        const payload = envelope.payload as ListSubagentsPayload | undefined;
        if (!payload?.workspaceId || !payload.sessionId) {
          sendWebSocket(
            socket,
            daemonMessageTypes.subagentsListed,
            {
              sessionId: payload?.sessionId ?? "",
              subagents: [],
              error: "workspaceId and sessionId are required",
            },
            envelope.id,
          );
          return;
        }
        sendSubagentList(
          socket,
          envelope.id,
          workspacePathFor(payload.workspaceId),
          payload,
        );
        return;
      }
      if (envelope.type === daemonMessageTypes.listDirectories) {
        const payload = envelope.payload as ListDirectoriesPayload | undefined;
        if (!payload?.path) {
          sendWebSocket(
            socket,
            daemonMessageTypes.directoriesListed,
            {
              path: "",
              directories: [],
              error: "list_directories requires path",
            },
            envelope.id,
          );
          return;
        }
        sendDirectoryListing(socket, envelope.id, payload);
        return;
      }
      if (envelope.type === daemonMessageTypes.listWorkspaceTree) {
        const payload = envelope.payload as
          ListWorkspaceTreePayload | undefined;
        if (!payload?.workspaceId) {
          sendWebSocket(
            socket,
            daemonMessageTypes.workspaceTreeListed,
            {
              entries: [],
              error: "list_workspace_tree requires workspaceId",
              path: payload?.path ?? "",
              workspaceId: payload?.workspaceId ?? "",
            },
            envelope.id,
          );
          return;
        }
        try {
          sendWorkspaceTreeListing(
            socket,
            envelope.id,
            workspacePathFor(payload.workspaceId),
            payload,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          sendWebSocket(
            socket,
            daemonMessageTypes.workspaceTreeListed,
            {
              entries: [],
              error: message,
              path: payload.path ?? "",
              workspaceId: payload.workspaceId,
            },
            envelope.id,
          );
        }
        return;
      }
      if (envelope.type === daemonMessageTypes.inspectWorkspace) {
        const payload = envelope.payload as {
          workspaceId: string;
          rescan?: boolean;
        };
        try {
          const inspection = await inspectWorkspace(
            workspacePathFor(payload.workspaceId),
            payload.workspaceId,
            payload.rescan === true,
          );
          sendWebSocket(
            socket,
            daemonMessageTypes.workspaceInspected,
            { inspection },
            envelope.id,
          );
        } catch (error) {
          sendWebSocket(
            socket,
            daemonMessageTypes.workspaceInspected,
            { error: String(error) },
            envelope.id,
          );
        }
        return;
      }
      if (envelope.type === daemonMessageTypes.setupWorkspace) {
        const payload = envelope.payload as SetupWorkspacePayload | undefined;
        if (!payload?.path) {
          sendWebSocket(
            socket,
            daemonMessageTypes.workspaceReady,
            { error: "setup_workspace requires path" },
            envelope.id,
          );
          return;
        }
        try {
          const workspacePath = existingWorkspaceFolder(payload.path);
          initWorkspace(workspacePath);
          await registerExecutionWorkspace(
            workspacePath,
            readWorkspace(workspacePath).id,
          );
          const registration = daemonRegistrationWithActiveSessions(
            workspacePath,
            options.sessionExecutions,
          );
          registerWorkspacePath(registration);
          sendWebSocket(
            socket,
            daemonMessageTypes.workspaceReady,
            { registration },
            envelope.id,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          sendWebSocket(
            socket,
            daemonMessageTypes.workspaceReady,
            { error: message },
            envelope.id,
          );
        }
        return;
      }
      if (envelope.type === daemonMessageTypes.forgetWorkspace) {
        const payload = envelope.payload as ForgetWorkspacePayload | undefined;
        if (!payload?.workspaceId && !payload?.path) {
          sendWebSocket(
            socket,
            daemonMessageTypes.workspaceForgotten,
            { error: "forget_workspace requires workspaceId or path" },
            envelope.id,
          );
          return;
        }
        try {
          const workspacePath =
            payload.path || workspacePaths.get(payload.workspaceId) || "";
          forgetWorkspaceRegistration(payload.workspaceId ?? "", workspacePath);
          unregisterWorkspacePath(payload.workspaceId ?? "", workspacePath);
          sendWebSocket(
            socket,
            daemonMessageTypes.workspaceForgotten,
            { workspaceId: payload.workspaceId ?? "" },
            envelope.id,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          sendWebSocket(
            socket,
            daemonMessageTypes.workspaceForgotten,
            {
              workspaceId: payload.workspaceId ?? "",
              error: message,
            },
            envelope.id,
          );
        }
        return;
      }
      if (envelope.type === daemonMessageTypes.startProfileAuthorization) {
        const payload = envelope.payload as
          StartProfileAuthorizationPayload | undefined;
        if (
          !payload?.profileId ||
          (payload.runtime !== "claude" && payload.runtime !== "codex")
        ) {
          sendWebSocket(
            socket,
            daemonMessageTypes.profileAuthorizationStarted,
            {
              error:
                "start_profile_authorization requires profileId and runtime",
            },
            envelope.id,
          );
          return;
        }
        void startProfileAuthorization(payload.profileId, payload.runtime)
          .then((authorization: ProfileAuthorization) => {
            trySendWebSocket(
              socket,
              daemonMessageTypes.profileAuthorizationStarted,
              { authorization },
              envelope.id,
            );
          })
          .catch((error) => {
            trySendWebSocket(
              socket,
              daemonMessageTypes.profileAuthorizationStarted,
              { error: error instanceof Error ? error.message : String(error) },
              envelope.id,
            );
          });
        return;
      }
      if (envelope.type === daemonMessageTypes.completeProfileAuthorization) {
        const payload = envelope.payload as
          CompleteProfileAuthorizationPayload | undefined;
        if (!payload?.flowId) {
          sendWebSocket(
            socket,
            daemonMessageTypes.profileAuthorizationCompleted,
            { error: "complete_profile_authorization requires flowId" },
            envelope.id,
          );
          return;
        }
        void completeProfileAuthorization(
          payload.flowId,
          payload.authorizationResult,
        )
          .then((authorization) => {
            trySendWebSocket(
              socket,
              daemonMessageTypes.profileAuthorizationCompleted,
              {
                authorization,
                registration: daemonRegistration(options.workspacePath),
              },
              envelope.id,
            );
          })
          .catch((error) => {
            trySendWebSocket(
              socket,
              daemonMessageTypes.profileAuthorizationCompleted,
              { error: error instanceof Error ? error.message : String(error) },
              envelope.id,
            );
          });
        return;
      }
      if (envelope.type === daemonMessageTypes.inspectNativeAccount) {
        const input = envelope.payload as { runtime?: string; source?: string };
        if (input?.runtime !== "claude" && input?.runtime !== "codex") {
          trySendWebSocket(
            socket,
            daemonMessageTypes.nativeAccountInspected,
            { error: "Unknown runtime." },
            envelope.id,
          );
          return;
        }
        void inspectNativeAccount(input.runtime, input.source)
          .then((result) => {
            trySendWebSocket(
              socket,
              daemonMessageTypes.nativeAccountInspected,
              { result },
              envelope.id,
            );
          })
          .catch(() => {
            trySendWebSocket(
              socket,
              daemonMessageTypes.nativeAccountInspected,
              { error: "Could not inspect this native account." },
              envelope.id,
            );
          });
        return;
      }
      if (envelope.type === daemonMessageTypes.listAgentModels) {
        const payload = envelope.payload as ListAgentModelsPayload | undefined;
        if (!payload?.profile) {
          sendWebSocket(
            socket,
            daemonMessageTypes.agentModelsListed,
            { error: "list_agent_models requires profile" },
            envelope.id,
          );
          return;
        }
        void listAgentModelsConfig(payload.profile, options.workspacePath)
          .then((models) => {
            trySendWebSocket(
              socket,
              daemonMessageTypes.agentModelsListed,
              { models },
              envelope.id,
            );
          })
          .catch((error) => {
            const message =
              error instanceof Error ? error.message : String(error);
            trySendWebSocket(
              socket,
              daemonMessageTypes.agentModelsListed,
              { error: message },
              envelope.id,
            );
          });
        return;
      }
      if (envelope.type === daemonMessageTypes.readProfileCredential) {
        const payload = envelope.payload as
          ReadProfileCredentialPayload | undefined;
        if (!payload?.profileId) {
          sendWebSocket(
            socket,
            daemonMessageTypes.profileCredentialRead,
            { error: "read_profile_credential requires profileId" },
            envelope.id,
          );
          return;
        }
        // Answers this one request and nothing else: the key goes straight
        // into the reply envelope for the server's promote flow, and is never
        // written to a log line or held anywhere else.
        try {
          sendWebSocket(
            socket,
            daemonMessageTypes.profileCredentialRead,
            { credential: localProfileCredential(payload.profileId) },
            envelope.id,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          sendWebSocket(
            socket,
            daemonMessageTypes.profileCredentialRead,
            { error: message },
            envelope.id,
          );
        }
        return;
      }
      if (envelope.type === daemonMessageTypes.scanSkills) {
        const payload = envelope.payload as { roots?: string[] } | undefined;
        try {
          const roots = Array.isArray(payload?.roots)
            ? payload.roots.filter(
                (root): root is string => typeof root === "string",
              )
            : [];
          const skills = scanSkillRoots(roots).map(toDeviceSkill);
          sendWebSocket(
            socket,
            daemonMessageTypes.skillsScanned,
            { skills },
            envelope.id,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          sendWebSocket(
            socket,
            daemonMessageTypes.skillsScanned,
            { error: message },
            envelope.id,
          );
        }
        return;
      }
      if (envelope.type === daemonMessageTypes.readSkillFile) {
        const payload = envelope.payload as {
          root: string;
          dirName: string;
          path: string;
        };
        try {
          const value = readSkillTextFile(
            payload.root,
            payload.dirName,
            payload.path,
          );
          sendWebSocket(
            socket,
            daemonMessageTypes.skillFileRead,
            value,
            envelope.id,
          );
        } catch (error) {
          sendWebSocket(
            socket,
            daemonMessageTypes.skillFileRead,
            { error: error instanceof Error ? error.message : String(error) },
            envelope.id,
          );
        }
        return;
      }
      if (envelope.type === daemonMessageTypes.readSkillContent) {
        const payload = envelope.payload as
          { root?: string; dirName?: string } | undefined;
        if (!payload?.root || !payload?.dirName) {
          sendWebSocket(
            socket,
            daemonMessageTypes.skillContentRead,
            { error: "read_skill_content requires root and dirName" },
            envelope.id,
          );
          return;
        }
        try {
          const content = packageSkillDirectory(payload.root, payload.dirName);
          sendWebSocket(
            socket,
            daemonMessageTypes.skillContentRead,
            content,
            envelope.id,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          sendWebSocket(
            socket,
            daemonMessageTypes.skillContentRead,
            { error: message },
            envelope.id,
          );
        }
        return;
      }
      if (envelope.type === daemonMessageTypes.upsertAgentProfile) {
        const payload = envelope.payload as
          UpsertAgentProfilePayload | undefined;
        if (!payload?.profile) {
          sendWebSocket(
            socket,
            daemonMessageTypes.agentProfileUpserted,
            { error: "upsert_agent_profile requires profile" },
            envelope.id,
          );
          return;
        }
        try {
          const targetWorkspacePath = payload.profile.workspaceId
            ? workspacePathFor(payload.profile.workspaceId)
            : options.workspacePath;
          const profile = upsertAgentProfileConfig(
            payload.profile,
            targetWorkspacePath,
          );
          const registration = daemonRegistrationWithActiveSessions(
            targetWorkspacePath,
            options.sessionExecutions,
          );
          registerWorkspacePath(registration);
          sendWebSocket(
            socket,
            daemonMessageTypes.agentProfileUpserted,
            { profile, registration },
            envelope.id,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          sendWebSocket(
            socket,
            daemonMessageTypes.agentProfileUpserted,
            { error: message },
            envelope.id,
          );
        }
        return;
      }
      if (envelope.type === daemonMessageTypes.upsertAgentRuntimeSettings) {
        const payload = envelope.payload as
          UpsertAgentRuntimeSettingsPayload | undefined;
        if (!payload?.settings) {
          sendWebSocket(
            socket,
            daemonMessageTypes.agentRuntimeSettingsUpserted,
            { error: "upsert_agent_runtime_settings requires settings" },
            envelope.id,
          );
          return;
        }
        try {
          const settings = writeAgentRuntimeSettings(payload.settings);
          taskScheduler.setMaxConcurrentTasks(settings.maxConcurrentTasks);
          announceAdditionalIssueCapacity();
          const registration = daemonRegistrationWithActiveSessions(
            options.workspacePath,
            options.sessionExecutions,
          );
          registerWorkspacePath(registration);
          sendWebSocket(
            socket,
            daemonMessageTypes.agentRuntimeSettingsUpserted,
            { registration, settings },
            envelope.id,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          sendWebSocket(
            socket,
            daemonMessageTypes.agentRuntimeSettingsUpserted,
            { error: message },
            envelope.id,
          );
        }
        return;
      }
      if (envelope.type === daemonMessageTypes.steerSession) {
        const payload = envelope.payload as SteerSessionPayload | undefined;
        const sessionId = payload?.sessionId?.trim();
        const message = payload?.message?.trim();
        if (!sessionId || !message) {
          sendWebSocket(
            socket,
            daemonMessageTypes.sessionSteered,
            { error: "steer_session requires sessionId and message" },
            envelope.id,
          );
          return;
        }
        void steerActiveSession(sessionId, message)
          .then(() => {
            trySendWebSocket(
              socket,
              daemonMessageTypes.sessionSteered,
              { sessionId },
              envelope.id,
            );
          })
          .catch((error) => {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            trySendWebSocket(
              socket,
              daemonMessageTypes.sessionSteered,
              { sessionId, error: errorMessage },
              envelope.id,
            );
          });
        return;
      }
      if (envelope.type === daemonMessageTypes.cancelSession) {
        const payload = envelope.payload as CancelSessionPayload | undefined;
        const sessionId = payload?.sessionId?.trim();
        if (!sessionId) {
          sendWebSocket(
            socket,
            daemonMessageTypes.sessionCanceled,
            { error: "cancel_session requires sessionId" },
            envelope.id,
          );
          return;
        }
        void cancelActiveSession(sessionId)
          .then(() => {
            trySendWebSocket(
              socket,
              daemonMessageTypes.sessionCanceled,
              { sessionId },
              envelope.id,
            );
          })
          .catch((error) => {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            trySendWebSocket(
              socket,
              daemonMessageTypes.sessionCanceled,
              { sessionId, error: errorMessage },
              envelope.id,
            );
          });
        return;
      }
      if (envelope.type === daemonMessageTypes.runSession) {
        if (options.once && acceptedRun) {
          return;
        }
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
        const payload = envelope.payload as RunSessionPayload | undefined;
        if (!payload?.session) {
          console.error("Received run_session without a session payload.");
          return;
        }
        if (!options.sessionExecutions.claim(payload.session.id)) {
          console.log(
            `Ignoring duplicate run_session for ${payload.session.id}`,
          );
          return;
        }
        acceptedRun = true;
        void taskScheduler
          .schedule(sessionSchedulingKey(payload.session), async () => {
            console.log(
              `Running ${payload.session.provider} session ${payload.session.id}`,
            );
            try {
              const ambient: SessionAmbientEnv = {
                serverURL: options.serverURL,
                sessionToken: payload.sessionToken ?? "",
                workspaceID: payload.session.workspaceId,
              };
              await executeAgentSession(
                options.sessionTransport,
                sessionExecution(
                  workspacePathFor(payload.session.workspaceId),
                  payload.session,
                  ambient,
                ),
                payload.session,
                payload.credential,
                payload.profile,
                ambient,
              );
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              options.sessionTransport.send(
                daemonMessageTypes.sessionCompleted,
                {
                  sessionId: payload.session.id,
                  error: message,
                },
              );
            } finally {
              options.sessionExecutions.complete(payload.session.id);
              if (options.once) {
                finish("exit");
              }
            }
          })
          .catch((error: unknown) => {
            options.sessionExecutions.complete(payload.session.id);
            const message =
              error instanceof Error ? error.message : String(error);
            console.error(
              `Session ${payload.session.id} scheduling failed: ${message}`,
            );
          });
        return;
      }
      if (envelope.type === daemonMessageTypes.issueEnvironment) {
        const payload = envelope.payload as {
          action: string;
          workspaceId: string;
          issueId: string;
          revision: number;
        };
        try {
          workspacePathFor(payload.workspaceId);
          if (payload.action === "preview_start") {
            queuePreview(payload.issueId);
            void taskScheduler
              .schedule(`issue:${payload.issueId}`, () =>
                runIssuePreview(payload.workspaceId, payload.issueId),
              )
              .catch((error) => console.error(String(error)));
            trySendWebSocket(
              socket,
              daemonMessageTypes.issueEnvironmentResult,
              { status: "preview_queued", revision: payload.revision },
              envelope.id,
            );
            return;
          }
          const result = await issueEnvironmentAction(payload);
          trySendWebSocket(
            socket,
            daemonMessageTypes.issueEnvironmentResult,
            result,
            envelope.id,
          );
        } catch (error) {
          trySendWebSocket(
            socket,
            daemonMessageTypes.issueEnvironmentResult,
            { error: String(error) },
            envelope.id,
          );
        }
        return;
      }
      if (envelope.type === daemonMessageTypes.evidenceRequest) {
        const payload = envelope.payload as EvidenceWorkerRequest;
        try {
          const result = await evidenceWorkerAction(
            payload,
            undefined,
            workspacePathFor(payload.workspaceId),
          );
          trySendWebSocket(
            socket,
            daemonMessageTypes.evidenceResult,
            result,
            envelope.id,
          );
        } catch (error) {
          trySendWebSocket(
            socket,
            daemonMessageTypes.evidenceResult,
            { taskId: payload.taskId, error: String(error) },
            envelope.id,
          );
        }
        return;
      }
      if (envelope.type !== daemonMessageTypes.runIssue) {
        return;
      }
      if (options.once && acceptedRun) {
        return;
      }

      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }

      const payload = envelope.payload as RunIssuePayload | undefined;
      if (!payload?.issue) {
        console.error("Received run_issue without an issue payload.");
        return;
      }
      if (options.activeIssues.has(payload.issue.id)) return;
      options.activeIssues.add(payload.issue.id);
      acceptedRun = true;

      void taskScheduler
        .schedule(`issue:${payload.issue.id}`, async () => {
          console.log(
            `Claimed ${payload.issue.shortId}: ${payload.issue.title}`,
          );
          // Route to the workspace that owns this issue. The daemon can
          // register multiple workspaces, so using the main workspace path
          // here would execute secondary-workspace issues in the wrong place.
          const issueWorkspacePath = payload.issue.workspaceId
            ? workspacePathFor(payload.issue.workspaceId)
            : options.workspacePath;
          try {
            await executeIssue(
              options.serverURL,
              issueWorkspacePath,
              payload.issue,
              new ReliableRunTransport(options.sessionTransport),
              undefined,
              payload.skillRefs,
              payload.userFiles === "readable" ? "readable" : "hidden",
            );
            await syncReviews(options.serverURL, issueWorkspacePath);
          } finally {
            options.activeIssues.delete(payload.issue.id);
            if (options.once) {
              finish("exit");
            } else {
              options.sessionTransport.send(
                daemonMessageTypes.readyForIssue,
                {},
              );
            }
          }
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(
            `Issue ${payload.issue.shortId} scheduling failed: ${message}`,
          );
        });
    });

    socket.on("close", (code?: number, reason?: Buffer) => {
      options.sessionTransport.unbind(socket);
      if (isDeviceRemovedSignal({ code, reason: reason?.toString() })) {
        // Permanent server decision: park instead of backing off and
        // reconnecting. Local config is untouched pending an explicit repair.
        finish("removed");
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
      stopProfileAuthorizations();
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
      if (!finished) {
        rejectSession(error);
      }
    });
  });
}

/**
 * prepareExplicitPair is the only path that clears a device-removal marker.
 * It is invoked by the user-run pair/setup commands, never by the automatic
 * service. The device identity rotates so the machine registers as a new
 * device instead of colliding with the tombstone.
 */
function prepareExplicitPair(): void {
  if (!prepareExplicitRepair()) {
    return;
  }
  rmSync(devicePath, { force: true });
  console.log(
    "This machine had been removed from its Foundry server. Registering it as a new device.",
  );
}

/**
 * Exchanges --token for this device's credential; an existing credential for
 * the same server is kept otherwise, so re-running setup needs no new token.
 * FOUNDRY_PAIRING_TOKEN (containers) is used only while unpaired: the token
 * is single-use but the variable survives restarts.
 */
async function pairWithServer(
  args: string[],
  serverURL: string,
  workspacePath: string,
): Promise<void> {
  const existing = readDaemonConfig();
  const paired = Boolean(
    existing?.deviceCredential && existing.serverURL === serverURL,
  );
  const token =
    optionValue(args, "--token") ??
    (paired ? undefined : process.env.FOUNDRY_PAIRING_TOKEN?.trim());
  if (!token) {
    if (existing && paired) {
      writeDaemonConfig({ ...existing, workspacePath });
      return;
    }
    throw new Error(
      "A pairing token is required. In the Foundry web app open Devices → Add device and pass it with --token.",
    );
  }
  const { deviceId, credential } = await pairDevice(serverURL, token);
  writeDaemonConfig({
    pairedAt: new Date().toISOString(),
    deviceCredential: credential,
    serverURL,
    workspacePath,
  });
  console.log(`Paired this machine as ${deviceId}.`);
}

export async function pair(args: string[]): Promise<void> {
  const serverURL = serverURLFromArgs(args);
  const workspacePath = workspacePathFromArgs(args);
  prepareExplicitPair();
  await pairWithServer(args, serverURL, workspacePath);
  await registerDaemon(serverURL, workspacePath);
  console.log(`Paired ${workspacePath} with ${serverURL}`);
  console.log(
    "Run foundry-worker install-service to start this daemon at login.",
  );
}

export async function setup(args: string[]): Promise<void> {
  const serverURL = serverURLFromArgs(args);
  const workspacePath = workspacePathFromArgs(args);
  const noService = optionEnabled(args, "--no-service");
  const noStart = optionEnabled(args, "--no-start");

  console.log("Setting up Foundry local daemon...");
  await ensureServerReachable(serverURL);
  initWorkspace(workspacePath);
  await registerExecutionWorkspace(
    workspacePath,
    readWorkspace(workspacePath).id,
  );
  prepareExplicitPair();
  await pairWithServer(args, serverURL, workspacePath);
  await registerDaemon(serverURL, workspacePath);

  if (noService) {
    console.log("Service installation skipped (--no-service).");
  } else {
    installService(noStart ? ["--no-start"] : []);
  }

  console.log("");
  status();
  console.log("");
  console.log("Foundry daemon setup complete.");
}

export function logs(args: string[]): void {
  const lines = Number(optionValue(args, "--lines", "80"));
  const paths = serviceLogPaths();
  for (const [label, path] of [
    ["stdout", paths.out],
    ["stderr", paths.err],
  ] as const) {
    console.log(`== ${label}: ${path} ==`);
    if (!existsSync(path)) {
      console.log("(no log file)");
      continue;
    }
    const text = readFileSync(path, "utf8").split("\n");
    console.log(text.slice(Math.max(0, text.length - lines - 1)).join("\n"));
  }
}

export async function sync(args: string[]): Promise<void> {
  const serverURL = serverURLFromArgs(args);
  const workspacePath = workspacePathFromArgs(args);
  await syncReviews(serverURL, workspacePath);
}
