import { slotWaitNotice } from "../../slot-wait.js";
import { executionHostClient } from "../../execution-host/client.js";
import { reportWorkerFailure } from "../../worker-failure.js";
import {
  daemonMessageTypes,
  type ProtocolEnvelope,
  type CancelSessionPayload,
  type RecoverSessionPayload,
  type RunSessionPayload,
  type SteerSessionPayload,
} from "@bd777/foundry-protocol";
import { recoveredClarificationCompletion } from "../../issue-clarification.js";
import { recoveredIssueCompletion } from "../../issue-recovery.js";
import {
  ControlOutcomeUnknownError,
  cancelActiveSession,
  noteSessionInput,
  steerActiveSessionOnce,
  isNotSteerableError,
} from "../../session-control.js";
import {
  readAgentSessionCompletionMarker,
  recoveredSessionCompletion,
} from "../../session-helpers.js";
import { isVerificationSession } from "../../session-roles.js";
import { issueSessionCompletion } from "../../issue-execution.js";
import { sendWebSocket } from "../../transport.js";
import { verificationDirectory } from "../../verification-session.js";
import { sessionSchedulingKey } from "../../workspace-ops.js";
import type { DaemonContext } from "../context.js";
import { reply, type DaemonDispatch } from "../dispatch.js";
import { runAgentSession } from "../session-run.js";
import { runIssueExecution } from "./issues.js";
import { errorMessage } from "../../utils.js";

/** Running agent sessions: start, steer, cancel, and recover lost reports. */
export function registerSessionHandlers(dispatch: DaemonDispatch): void {
  dispatch
    .on(daemonMessageTypes.steerSession, onSteerSession)
    .on(daemonMessageTypes.cancelSession, onCancelSession)
    .on(daemonMessageTypes.recoverSession, onRecoverSession)
    .on(daemonMessageTypes.runSession, onRunSession);
}

function onSteerSession(envelope: ProtocolEnvelope, ctx: DaemonContext) {
  const payload = envelope.payload as SteerSessionPayload | undefined;
  const sessionId = payload?.sessionId?.trim();
  const message = payload?.message?.trim() ?? "";
  const attachments = payload?.attachments ?? [];
  if (!sessionId || (!message && attachments.length === 0)) {
    sendWebSocket(
      ctx.socket,
      daemonMessageTypes.sessionSteered,
      {
        error: "steer_session requires sessionId and a message or files",
      },
      envelope.id,
    );
    return;
  }
  const inputId = payload?.inputId?.trim() || undefined;
  const options =
    payload?.delivery === "interrupt" || payload?.delivery === "boundary"
      ? { delivery: payload.delivery, boundaryLimitMs: payload.boundaryLimitMs }
      : undefined;
  return reply(
    ctx,
    envelope,
    daemonMessageTypes.sessionSteered,
    async () => {
      const host = executionHostClient();
      if (host)
        await host.steer(
          sessionId,
          inputId,
          message,
          attachments,
          payload?.sentBySessionId,
          options,
        );
      else
        await steerActiveSessionOnce(
          sessionId,
          inputId,
          message,
          attachments,
          payload?.sentBySessionId,
          options,
        );
      return { sessionId, inputId };
    },
    (error, cause) => ({
      sessionId,
      inputId,
      error,
      outcomeUnknown: cause instanceof ControlOutcomeUnknownError,
      // The server holds a message the session cannot take now.
      notSteerable: isNotSteerableError(cause ?? error),
    }),
  );
}

function onCancelSession(envelope: ProtocolEnvelope, ctx: DaemonContext) {
  const payload = envelope.payload as CancelSessionPayload | undefined;
  const sessionId = payload?.sessionId?.trim();
  if (!sessionId) {
    sendWebSocket(
      ctx.socket,
      daemonMessageTypes.sessionCanceled,
      { error: "cancel_session requires sessionId" },
      envelope.id,
    );
    return;
  }
  return reply(
    ctx,
    envelope,
    daemonMessageTypes.sessionCanceled,
    async () => {
      const host = executionHostClient();
      const outcome = host
        ? await host.cancel(sessionId, payload?.inputId?.trim())
        : await cancelActiveSession(sessionId, payload?.inputId?.trim());
      return { sessionId, ...outcome };
    },
    (error) => ({ sessionId, error }),
  );
}

async function onRecoverSession(
  envelope: ProtocolEnvelope,
  ctx: DaemonContext,
) {
  const payload = envelope.payload as RecoverSessionPayload | undefined;
  const sessionId = payload?.sessionId?.trim();
  const inputId = payload?.inputId?.trim() ?? "";
  const host = executionHostClient();
  if (host) {
    await host.refresh();
    if (sessionId && host.owns(sessionId, inputId)) return;
  }
  // Never recover an input still executing. A recently completed dispatch
  // may have lost its report (including a mistaken permanent ACK); report
  // its persisted result again when the server explicitly asks. Dispatch
  // deduplication still uses handled(), so this never reruns the input.
  if (
    !payload ||
    !sessionId ||
    ctx.sessionExecutions.isActive(sessionId, inputId)
  ) {
    return;
  }
  if (payload.role === "issue_clarification" && payload.issueId) {
    console.log(`Reporting orphaned Issue clarification ${sessionId}`);
    ctx.sessionTransport.send(
      daemonMessageTypes.sessionCompleted,
      recoveredClarificationCompletion(
        payload.workspaceId,
        payload.issueId,
        sessionId,
        inputId,
      ),
    );
    return;
  }
  if (payload.issueId) {
    console.log(`Reporting orphaned Issue execution ${sessionId}`);
    const completion = recoveredIssueCompletion(
      payload.workspaceId,
      payload.issueId,
      sessionId,
    );
    ctx.sessionTransport.send(
      daemonMessageTypes.sessionCompleted,
      completion
        ? issueSessionCompletion(sessionId, inputId, completion)
        : {
            sessionId,
            inputId: inputId || undefined,
            error:
              "The worker restarted before this execution started; retry to run it again.",
          },
    );
    return;
  }
  let workspacePath: string;
  try {
    workspacePath = ctx.roster.pathFor(payload.workspaceId);
  } catch {
    return;
  }
  console.log(`Reporting orphaned session ${sessionId} ${inputId}`);
  ctx.sessionTransport.send(
    daemonMessageTypes.sessionCompleted,
    recoveredSessionCompletion(workspacePath, sessionId, inputId),
  );
}

function onRunSession(envelope: ProtocolEnvelope, ctx: DaemonContext) {
  if (ctx.once && ctx.state.acceptedRun) {
    return;
  }
  if (ctx.state.idleTimer) {
    clearTimeout(ctx.state.idleTimer);
    ctx.state.idleTimer = undefined;
  }
  const payload = envelope.payload as RunSessionPayload | undefined;
  if (!payload?.session) {
    console.error("Received run_session without a session payload.");
    return;
  }
  const inputId = payload.session.input?.id ?? "";
  const host = executionHostClient();
  if (host) {
    ctx.state.acceptedRun = true;
    // The host persists acceptance and owns duplicate suppression across workers.
    void host
      .run(ctx.roster.folderFor(payload.session.workspaceId), payload)
      .catch((error) => {
        console.error(
          `Execution dispatch acknowledgement: ${errorMessage(error)}`,
        );
      });
    return;
  }
  if (!ctx.sessionExecutions.claim(payload.session.id, inputId)) {
    console.log(
      `Ignoring duplicate run_session for ${payload.session.id} ${inputId}`,
    );
    return;
  }
  ctx.state.acceptedRun = true;
  // A steer of the same message arriving late must not add it to
  // this input's own turn.
  if (inputId) noteSessionInput(payload.session.id, inputId);
  if (payload.session.role === "issue_execution") {
    runIssueExecution(ctx, payload, inputId);
    return;
  }
  // An input that already finished here (its report lost with an
  // earlier process) is reported again rather than run twice.
  const recorded = recordedCompletion(ctx, payload.session, inputId);
  if (recorded) {
    ctx.sessionTransport.send(daemonMessageTypes.sessionCompleted, recorded);
    ctx.sessionExecutions.complete(payload.session.id, inputId);
    if (ctx.once) ctx.finish("exit");
    return;
  }
  scheduleAgentSession(ctx, payload, inputId);
}

/** The report this device recorded for the input, if it already finished here. */
function recordedCompletion(
  ctx: DaemonContext,
  session: RunSessionPayload["session"],
  inputId: string,
): Record<string, unknown> | undefined {
  try {
    if (session.role === "issue_clarification") {
      const report = recoveredClarificationCompletion(
        session.workspaceId,
        session.issueId ?? "",
        session.id,
        inputId,
      );
      return report.clarificationResult ? report : undefined;
    }
    if (session.issueId) return undefined;
    const marker = readAgentSessionCompletionMarker(
      isVerificationSession(session)
        ? verificationDirectory(session.workspaceId, session.id)
        : ctx.roster.pathFor(session.workspaceId),
      session.id,
      inputId,
    );
    return (
      marker && {
        sessionId: session.id,
        inputId: inputId || undefined,
        nativeSessionId: marker.nativeSessionId,
        response: marker.response,
      }
    );
  } catch {
    return undefined;
  }
}

/** Runs the session when the scheduler has room; its outcome is always reported. */
function scheduleAgentSession(
  ctx: DaemonContext,
  payload: RunSessionPayload,
  inputId: string,
): void {
  const slotWait = slotWaitNotice(ctx.sessionTransport, payload.session);
  void ctx.taskScheduler
    .schedule(
      sessionSchedulingKey(payload.session),
      async () => {
        slotWait.started(ctx.taskScheduler.load());
        console.log(
          `Running ${payload.session.provider} session ${payload.session.id}`,
        );
        try {
          await runAgentSession(
            ctx.serverURL,
            ctx.roster.folderFor(payload.session.workspaceId),
            ctx.sessionTransport,
            payload,
          );
        } catch (error) {
          reportWorkerFailure(ctx.sessionTransport, payload.session, error);
        } finally {
          ctx.sessionExecutions.complete(payload.session.id, inputId);
          if (ctx.once) {
            ctx.finish("exit");
          }
        }
      },
      slotWait.onWait,
    )
    .catch((error: unknown) => {
      ctx.sessionExecutions.complete(payload.session.id, inputId);
      const message = errorMessage(error);
      console.error(
        `Session ${payload.session.id} scheduling failed: ${message}`,
      );
    });
}
