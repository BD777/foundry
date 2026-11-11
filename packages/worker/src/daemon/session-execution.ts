import { withWorkspaceDraftSkills } from "../skills/workspace-skill-runtime.js";
import {
  daemonMessageTypes,
  processLabels,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionEventMetadata,
  type ProfileDefinition,
  sessionEventLabels,
} from "@bd777/foundry-protocol";
import { issueSessionExecution } from "../issue/issue-sessions.js";
import {
  profileConfigForSession,
  profileID,
  withDispatchCredential,
  type AgentProfileLocalConfig,
} from "../harness/profiles.js";
import { withSessionContextWindow } from "../harness/context-window.js";
import { reclaimSessionResources } from "../resources/resource-pool.js";
import {
  sessionHasNativeWork,
  sessionHasRunningBackgroundTasks,
} from "../session/runner/active-runtimes.js";
import { redactTranscriptText } from "../platform/secret-redaction.js";
import {
  registerSessionAmbientEnv,
  type SessionAmbientEnv,
} from "../session/session-ambient.js";
import {
  forgetActiveSession,
  isAgentSessionCanceledError,
  takeQueuedSessionCancel,
  registerActiveSessionCancelTarget,
  AgentSessionCanceledError,
} from "../session/session-control.js";
import {
  createResponseStreamBatcher,
  createResponseStreamEventIDAllocator,
  createSessionStatusEventFilter,
  createSubtaskProgressCoalescer,
  inputScopedMessage,
  sessionEvent,
  writeAgentSessionCompletionMarker,
} from "../session/session-helpers.js";
import {
  isVerificationSession,
  isUtilitySession,
} from "../session/session-roles.js";
import type { OutOfBandSessionEvent } from "../session/session-state.js";
import { runWorkspaceSession } from "../session/index.js";
import type {
  AgentTurn,
  SessionExecution,
  SessionRole,
} from "../session/session-role.js";
import {
  materializeSessionSkills,
  type ManagedSkillRuntime,
} from "../skills/skill-materializer.js";
import type { ReliableSessionTransport } from "../transport/transport.js";
import { verificationExecution } from "../session/verification-session.js";
import { reportWorkerFailure } from "../session/worker-failure.js";

// Chats run unsandboxed in the workspace itself; Issue-backed sessions run
// where and how the Issue decides; a verifier runs in the workspace inside a
// sandbox that keeps it read-only.
export function sessionExecution(
  rootPath: string,
  session: AgentSession,
  ambient: SessionAmbientEnv,
): SessionExecution {
  const issueId = session.issueId?.trim();
  if (issueId)
    return issueSessionExecution(
      session.workspaceId,
      issueId,
      session.id,
      ambient,
    );
  if (isVerificationSession(session))
    return verificationExecution(session, rootPath, ambient);
  return { cwd: rootPath, stateRoot: rootPath };
}

/**
 * One per process: a subagent reports progress both inside a turn and,
 * running in the background, between turns (the out-of-band sink).
 */
const coalesceSubtaskProgress = createSubtaskProgressCoalescer();

/**
 * Timer-driven background turns arrive while no Foundry turn is active.
 * They cross the socket as ordinary session_event envelopes, which the
 * server persists and broadcasts like turn-scoped events.
 */
export function outOfBandEventSink(
  transport: ReliableSessionTransport,
): (sessionId: string, partial: OutOfBandSessionEvent) => void {
  return (sessionId, partial) =>
    coalesceSubtaskProgress(sessionId, partial, () =>
      transport.send(daemonMessageTypes.sessionEvent, {
        event: sessionEvent(
          sessionId,
          partial.label,
          partial.detail,
          partial.level ?? "info",
          undefined,
          partial.metadata,
          partial.message,
        ),
      }),
    );
}

/**
 * Runs one dispatched input of a session, whatever its role: reports that it
 * started, lets the role decide where it runs, prepares its profile and
 * skills, runs its agent, and reports its events and its answer, failure or
 * stop; its steer and cancel reach it through session-control.
 */
export async function executeAgentSession(
  transport: ReliableSessionTransport,
  dispatched: AgentSession,
  role: SessionRole,
  dispatchCredential?: string,
  dispatchProfile?: ProfileDefinition,
  ambient?: SessionAmbientEnv,
): Promise<void> {
  let session = dispatched;
  const inputId = session.input?.id;
  // A role that reports its own stop starts first: the stop it reports
  // ends a started input.
  const canceledBeforeStart = takeQueuedSessionCancel(session.id, inputId);
  if (canceledBeforeStart && !role.stopped) {
    transport.send(daemonMessageTypes.sessionCompleted, {
      sessionId: session.id,
      inputId,
      ...(session.dispatchId ? { dispatchId: session.dispatchId } : {}),
      error: "Session canceled before it started.",
    });
    return;
  }
  const unregisterAmbient = ambient
    ? registerSessionAmbientEnv(session.id, ambient)
    : () => {};
  // Response events are named per input: every input of a session has its
  // own answers, and a later one must never overwrite an earlier one.
  const responseEventID = createResponseStreamEventIDAllocator(
    session.input ? `${session.id}_${session.input.id}` : session.id,
  );
  const shouldSendEvent = createSessionStatusEventFilter();
  const sendEvent = (
    label: string,
    detail: string,
    level: AgentSessionEvent["level"],
    metadata?: AgentSessionEventMetadata,
    message?: AgentSessionEvent["message"],
    knownEventID?: string,
  ): void => {
    if (!shouldSendEvent({ label, detail, level, metadata })) {
      return;
    }
    const eventID = responseEventID(label, message?.id) ?? knownEventID;
    coalesceSubtaskProgress(session.id, { label, metadata }, () =>
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
      }),
    );
  };
  const responseStream = createResponseStreamBatcher<{
    label: string;
    detail: string;
    level: AgentSessionEvent["level"];
    metadata?: AgentSessionEventMetadata;
    message?: AgentSessionEvent["message"];
  }>((pending) =>
    sendEvent(
      pending.label,
      pending.detail,
      pending.level,
      pending.metadata,
      pending.message,
    ),
  );
  const flushPendingResponse = responseStream.flush;
  // A session waiting out a model rate-limit retry is blocked (active but
  // waiting), not running. Any other progress — including the next response
  // stream after the retry — clears the marker.
  let markedBlocked = false;
  const blockOnRateLimitLabels = new Set<string>([
    processLabels.rateLimited,
    processLabels.modelRetry,
  ]);

  const emit = async (
    label: string,
    detail: string,
    level: AgentSessionEvent["level"] = "info",
    metadata?: AgentSessionEventMetadata,
    message?: AgentSessionEvent["message"],
    eventId?: string,
  ): Promise<void> => {
    message = inputScopedMessage(session, message);
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
    if (
      label === sessionEventLabels.responseStream ||
      label === processLabels.commentary
    ) {
      responseStream.offer({ label, detail, level, metadata, message });
      return;
    }
    flushPendingResponse();
    sendEvent(label, detail, level, metadata, message, eventId);
  };
  // Resource Pool lease: browser processes this session started and left
  // running are closed when its input ends — unless background work the
  // turn left running may still use them; a later input's end reclaims them.
  const reclaimResources = async (): Promise<void> => {
    if (sessionHasRunningBackgroundTasks(session.id)) return;
    const reclaimed = reclaimSessionResources(session.id);
    if (reclaimed.length)
      await emit("Closed leftover browser processes", reclaimed.join(", "));
  };

  const reportedNativeSessionIds = new Set<string>();
  const reportNativeSessionId = (nativeSessionId: string): void => {
    const trimmed = nativeSessionId?.trim();
    if (!trimmed || reportedNativeSessionIds.has(trimmed)) {
      return;
    }
    reportedNativeSessionIds.add(trimmed);
    role.nativeSessionId?.(trimmed);
    transport.send(daemonMessageTypes.sessionNativeSessionId, {
      sessionId: session.id,
      nativeSessionId: trimmed,
    });
  };

  transport.send(daemonMessageTypes.sessionStarted, {
    sessionId: session.id,
    inputId,
    ...(session.dispatchId ? { dispatchId: session.dispatchId } : {}),
  });
  try {
    // Until the agent runs, a cancel stops the preparation.
    const preparing = new AbortController();
    const stopPreparing = registerActiveSessionCancelTarget(session.id, {
      provider: session.provider,
      inputId,
      cancel: () => preparing.abort(new AgentSessionCanceledError()),
    });
    let execution: SessionExecution;
    let profile: AgentProfileLocalConfig;
    let managedSkills: ManagedSkillRuntime;
    let lastSkillProgress = Date.now();
    let lastSkillDownload = 0;
    try {
      if (canceledBeforeStart || takeQueuedSessionCancel(session.id, inputId))
        preparing.abort(new AgentSessionCanceledError());
      preparing.signal.throwIfAborted();
      ({ execution, session } = await role.prepare(emit));
      preparing.signal.throwIfAborted();
      profile = await withSessionContextWindow(
        withDispatchCredential(
          profileConfigForSession(execution.cwd, session, dispatchProfile),
          dispatchCredential,
        ),
        session,
      );
      // Resolve the workspace-selected skills into a managed runtime tree
      // before the agent starts. An empty selection materializes an empty
      // allowlist, which the runner enforces as "expose nothing".
      await emit(
        "Preparing skills",
        `Checking ${session.skillRefs?.length ?? 0} selected Skill revisions; prepared versions are reused.`,
      );
      managedSkills = await materializeSessionSkills(
        session.skillRefs ?? [],
        ambient?.serverURL ?? "",
        execution.cwd,
        {
          signal: preparing.signal,
          onDownload: async (ref) => {
            if (Date.now() - lastSkillDownload < 1500) return;
            lastSkillDownload = Date.now();
            await emit(
              "Downloading skill",
              `Preparing missing version: ${ref.name}, revision ${ref.revision}.`,
            );
          },
          onProgress: async (stats) => {
            if (Date.now() - lastSkillProgress < 1500) return;
            lastSkillProgress = Date.now();
            await emit(
              "Preparing skills",
              `${stats.completed}/${stats.total} ready; ${stats.expandedCache} prepared versions reused, ${stats.archiveCache} local archives expanded, ${stats.downloaded} downloaded.`,
            );
          },
          onComplete: async (stats) => {
            await emit(
              "Skills ready",
              `${stats.total} selected revisions ready in ${Math.round(stats.elapsedMs)} ms; ${stats.expandedCache} prepared versions reused, ${stats.archiveCache} local archives expanded, ${stats.downloaded} downloaded. Timing (ms): verification=${Math.round(stats.verifyMs)}, download=${Math.round(stats.downloadMs)}, expansion=${Math.round(stats.unpackMs)}, session tree=${Math.round(stats.snapshotMs)}.`,
            );
          },
          onRetry: (message) =>
            emit("Skill download retry", message, "warning"),
        },
      );
    } finally {
      stopPreparing();
    }
    let setupEmitted = false;
    const emitSetup = async (): Promise<void> => {
      if (setupEmitted) {
        return;
      }
      setupEmitted = true;
      await emit("Loaded workspace", execution.cwd);
      await emit(
        "Selected profile",
        `${profile.label ?? profileID(profile)} · ${profile.connectionType ?? "local_login"}`,
      );
    };
    if (
      session.workspaceDraftSkills &&
      !isVerificationSession(session) &&
      !isUtilitySession(session)
    ) {
      managedSkills = await withWorkspaceDraftSkills(managedSkills, {
        workspaceId: session.workspaceId,
        executionRootId:
          session.issueId && session.role !== "issue_clarification"
            ? `issue:${session.issueId}`
            : session.workspaceId,
        workspacePath: execution.cwd,
      });
      await emit(
        "Workspace draft skills",
        JSON.stringify(managedSkills.draftSkills),
      );
    }
    if (managedSkills.skills.length > 0) {
      await emit(
        "Loaded skills",
        managedSkills.skills.map((skill) => skill.name).join(", "),
      );
    }
    // Session liveness is carried by the process-scoped execution claim on
    // the daemon connection. Do not manufacture visible transcript events
    // when the provider has produced no actual progress or response content.
    const agent: AgentTurn = (turn, sandbox = execution.sandbox) =>
      runWorkspaceSession({
        cwd: execution.cwd,
        session: turn,
        profile,
        managedSkills,
        emit,
        emitSetup,
        reportNativeSessionId,
        sandbox,
      });
    const result = role.run
      ? await role.run(agent, emit)
      : await agent(session);
    flushPendingResponse();
    await reclaimResources();
    const settled = await role.settle?.(result, emit);
    flushPendingResponse();
    writeAgentSessionCompletionMarker(execution.stateRoot, session, result);
    transport.send(daemonMessageTypes.sessionCompleted, {
      sessionId: session.id,
      inputId,
      ...(session.dispatchId ? { dispatchId: session.dispatchId } : {}),
      nativeSessionId: result.nativeSessionId,
      response: redactTranscriptText(result.response),
      ...settled,
      // Its agent goes on (a background command, a timer): the server
      // keeps the session's connector grants live without waiting for the
      // next heartbeat's claim.
      ...(sessionHasNativeWork(session.id) ? { nativeWork: true } : {}),
    });
  } catch (error) {
    await reclaimResources();
    const canceled = isAgentSessionCanceledError(error);
    if (canceled)
      await emit("Session canceled", "Canceled by user.", "warning");
    flushPendingResponse();
    const stopped = role.stopped?.(error, canceled);
    if (!canceled) reportWorkerFailure(transport, session, error, stopped);
    else if (stopped)
      transport.send(daemonMessageTypes.sessionCompleted, {
        sessionId: session.id,
        inputId,
        ...(session.dispatchId ? { dispatchId: session.dispatchId } : {}),
        ...stopped,
      });
  } finally {
    flushPendingResponse();
    unregisterAmbient();
    forgetActiveSession(session.id);
  }
}
