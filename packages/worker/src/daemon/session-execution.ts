import {
  daemonMessageTypes,
  processLabels,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionEventMetadata,
  type ProfileDefinition,
} from "@bd777/foundry-protocol";
import { issueSessionExecution } from "../issue-sessions.js";
import {
  profileConfigForSession,
  profileID,
  withDispatchCredential,
} from "../profiles.js";
import { withSessionContextWindow } from "../context-window.js";
import { reclaimSessionResources } from "../resource-pool.js";
import { sessionHasRunningBackgroundTasks } from "../runner/active-runtimes.js";
import { redactTranscriptText } from "../secret-redaction.js";
import {
  registerSessionAmbientEnv,
  type SessionAmbientEnv,
} from "../session-ambient.js";
import {
  forgetActiveSession,
  isAgentSessionCanceledError,
  takeQueuedSessionCancel,
} from "../session-control.js";
import {
  createResponseStreamBatcher,
  createResponseStreamEventIDAllocator,
  createSessionStatusEventFilter,
  createSubtaskProgressCoalescer,
  inputScopedMessage,
  sessionEvent,
  writeAgentSessionCompletionMarker,
} from "../session-helpers.js";
import { isVerificationSession } from "../session-roles.js";
import type {
  AgentSessionRunResult,
  OutOfBandSessionEvent,
} from "../session-state.js";
import {
  runWorkspaceSession,
  type WorkspaceSandbox,
} from "../session/index.js";
import { materializeSessionSkills } from "../skill-materializer.js";
import type { ReliableSessionTransport } from "../transport.js";
import { verificationExecution } from "../verification-session.js";
import { errorMessage } from "../utils.js";

/** Where a dispatched session runs and keeps its state. */
export interface SessionExecution {
  /** Directory the agent works in. */
  cwd: string;
  /** Directory that receives Foundry's own session records. */
  stateRoot: string;
  sandbox?: WorkspaceSandbox;
}

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

export async function executeAgentSession(
  transport: ReliableSessionTransport,
  execution: SessionExecution,
  session: AgentSession,
  dispatchCredential?: string,
  dispatchProfile?: ProfileDefinition,
  ambient?: SessionAmbientEnv,
  /** What the session's role adds to its completion report. */
  settle?: (result: AgentSessionRunResult) => Record<string, unknown>,
): Promise<void> {
  const workspacePath = execution.cwd;
  const unregisterAmbient = ambient
    ? registerSessionAmbientEnv(session.id, ambient)
    : () => {};
  if (takeQueuedSessionCancel(session.id, session.input?.id)) {
    transport.send(daemonMessageTypes.sessionCompleted, {
      sessionId: session.id,
      inputId: session.input?.id,
      error: "Session canceled before it started.",
    });
    unregisterAmbient();
    return;
  }
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
    detail: string;
    level: AgentSessionEvent["level"];
    metadata?: AgentSessionEventMetadata;
    message?: AgentSessionEvent["message"];
  }>((pending) =>
    sendEvent(
      "Response stream",
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
    if (label === "Response stream") {
      responseStream.offer({ detail, level, metadata, message });
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
    transport.send(daemonMessageTypes.sessionNativeSessionId, {
      sessionId: session.id,
      nativeSessionId: trimmed,
    });
  };

  transport.send(daemonMessageTypes.sessionStarted, {
    sessionId: session.id,
    inputId: session.input?.id,
  });
  try {
    const profile = await withSessionContextWindow(
      withDispatchCredential(
        profileConfigForSession(workspacePath, session, dispatchProfile),
        dispatchCredential,
      ),
      session,
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
    await reclaimResources();
    const settled = settle?.(result);
    writeAgentSessionCompletionMarker(execution.stateRoot, session, result);
    transport.send(daemonMessageTypes.sessionCompleted, {
      sessionId: session.id,
      inputId: session.input?.id,
      nativeSessionId: result.nativeSessionId,
      response: redactTranscriptText(result.response),
      ...settled,
    });
  } catch (error) {
    await reclaimResources();
    if (isAgentSessionCanceledError(error)) {
      await emit("Session canceled", "Canceled by user.", "warning");
      return;
    }
    const message = errorMessage(error);
    await emit("Session failed", message, "error");
    transport.send(daemonMessageTypes.sessionCompleted, {
      sessionId: session.id,
      inputId: session.input?.id,
      error: message,
    });
  } finally {
    flushPendingResponse();
    unregisterAmbient();
    forgetActiveSession(session.id);
  }
}
