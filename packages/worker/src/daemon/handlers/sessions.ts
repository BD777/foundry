import { executionHostClient } from "../../execution-host/client.js";
import { reportWorkerFailure } from "../../session/worker-failure.js";
import {
  daemonMessageTypes,
  type ProtocolEnvelope,
  type CancelSessionPayload,
  type RecoverSessionPayload,
  type RunSessionPayload,
  type SteerSessionPayload,
} from "@bd777/foundry-protocol";
import { recoveredClarificationCompletion } from "../../issue/issue-clarification.js";
import { recoveredIssueCompletion } from "../../issue/issue-recovery.js";
import {
  ControlOutcomeUnknownError,
  cancelActiveSession,
  steerActiveSessionOnce,
  isNotSteerableError,
} from "../../session/session-control.js";
import { recoveredSessionCompletion } from "../../session/session-helpers.js";
import { issueSessionCompletion } from "../../issue/issue-execution.js";
import { sendWebSocket } from "../../transport/transport.js";
import type { DaemonContext } from "../context.js";
import { reply, type DaemonDispatch } from "../dispatch.js";
import { errorMessage } from "../../platform/utils.js";

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
  const { session } = payload;
  const host = executionHostClient();
  if (host) {
    ctx.state.acceptedRun = true;
    let workspacePath: string;
    try {
      workspacePath = ctx.roster.folderFor(session.workspaceId);
    } catch (error) {
      reportWorkerFailure(ctx.sessionTransport, session, error);
      return;
    }
    // The host persists acceptance and owns duplicate suppression across workers.
    void host.run(workspacePath, payload).catch((error) => {
      console.error(
        `Execution dispatch acknowledgement: ${errorMessage(error)}`,
      );
    });
    return;
  }
  if (
    !ctx.executions.accept(payload, () =>
      ctx.roster.folderFor(session.workspaceId),
    )
  ) {
    console.log(
      `Ignoring duplicate run_session for ${session.id} ${session.input?.id ?? ""}`,
    );
    return;
  }
  ctx.state.acceptedRun = true;
}
