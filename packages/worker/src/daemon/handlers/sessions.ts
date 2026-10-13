import {
  daemonMessageTypes,
  type CancelSessionPayload,
  type RecoverSessionPayload,
  type RunSessionPayload,
  type SteerSessionPayload,
} from "@bd777/foundry-protocol";
import { materializeSessionAccounts } from "../../external-accounts.js";
import {
  prepareClarification,
  recoveredClarificationCompletion,
} from "../../issue-clarification.js";
import { recoveredIssueCompletion } from "../../issue-recovery.js";
import type { SessionAmbientEnv } from "../../session-ambient.js";
import {
  cancelActiveSession,
  noteSessionInput,
  steerActiveSessionOnce,
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
import { reply, type DaemonDispatch } from "../dispatch.js";
import { executeAgentSession, sessionExecution } from "../session-execution.js";
import { runIssueExecution } from "./issues.js";
import { errorMessage } from "../../utils.js";

/** Running agent sessions: start, steer, cancel, and recover lost reports. */
export function registerSessionHandlers(dispatch: DaemonDispatch): void {
  dispatch
    .on(daemonMessageTypes.steerSession, (envelope, ctx) => {
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
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.sessionSteered,
        async () => {
          await steerActiveSessionOnce(
            sessionId,
            inputId,
            message,
            attachments,
          );
          return { sessionId, inputId };
        },
        (error) => ({ sessionId, inputId, error }),
      );
    })
    .on(daemonMessageTypes.cancelSession, (envelope, ctx) => {
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
          const outcome = await cancelActiveSession(
            sessionId,
            payload?.inputId?.trim(),
          );
          return outcome.answered
            ? { sessionId, answered: true }
            : { sessionId };
        },
        (error) => ({ sessionId, error }),
      );
    })
    .on(daemonMessageTypes.recoverSession, (envelope, ctx) => {
      const payload = envelope.payload as RecoverSessionPayload | undefined;
      const sessionId = payload?.sessionId?.trim();
      const inputId = payload?.inputId?.trim() ?? "";
      // This process runs or just finished the input: its own report is
      // in the session outbox.
      if (
        !payload ||
        !sessionId ||
        ctx.sessionExecutions.handled(sessionId, inputId)
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
    })
    .on(daemonMessageTypes.runSession, (envelope, ctx) => {
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
      const clarifying = payload.session.role === "issue_clarification";
      let recorded: Record<string, unknown> | undefined;
      try {
        if (clarifying) {
          const report = recoveredClarificationCompletion(
            payload.session.workspaceId,
            payload.session.issueId ?? "",
            payload.session.id,
            inputId,
          );
          recorded = report.clarificationResult ? report : undefined;
        } else if (!payload.session.issueId) {
          const marker = readAgentSessionCompletionMarker(
            isVerificationSession(payload.session)
              ? verificationDirectory(
                  payload.session.workspaceId,
                  payload.session.id,
                )
              : ctx.roster.pathFor(payload.session.workspaceId),
            payload.session.id,
            inputId,
          );
          recorded = marker && {
            sessionId: payload.session.id,
            inputId: inputId || undefined,
            nativeSessionId: marker.nativeSessionId,
            response: marker.response,
          };
        }
      } catch {
        recorded = undefined;
      }
      if (recorded) {
        ctx.sessionTransport.send(
          daemonMessageTypes.sessionCompleted,
          recorded,
        );
        ctx.sessionExecutions.complete(payload.session.id, inputId);
        if (ctx.once) ctx.finish("exit");
        return;
      }
      void ctx.taskScheduler
        .schedule(sessionSchedulingKey(payload.session), async () => {
          console.log(
            `Running ${payload.session.provider} session ${payload.session.id}`,
          );
          // Its tool profiles live while this run does; a run that never
          // returns (a killed worker) leaves them to the next start's reap.
          let releaseAccounts = () => {};
          try {
            const ambient: SessionAmbientEnv = {
              serverURL: ctx.serverURL,
              sessionToken: payload.sessionToken ?? "",
              workspaceID: payload.session.workspaceId,
            };
            const workspacePath = ctx.roster.folderFor(
              payload.session.workspaceId,
            );
            // An Issue's clarification runs read-only in the workspace with
            // its turn's draft; its answer becomes the reply on the Issue.
            const clarification = clarifying
              ? await prepareClarification(
                  payload.session,
                  payload.clarification,
                  workspacePath,
                  ambient,
                )
              : undefined;
            if (!clarification)
              releaseAccounts = (
                await materializeSessionAccounts(
                  payload.session,
                  payload.externalAccounts,
                  {
                    serverURL: ctx.serverURL,
                    log: (message) => console.log(message),
                  },
                )
              ).release;
            await executeAgentSession(
              ctx.sessionTransport,
              clarification?.execution ??
                sessionExecution(workspacePath, payload.session, ambient),
              clarification?.session ?? payload.session,
              payload.credential,
              payload.profile,
              ambient,
              clarification?.settle,
            );
          } catch (error) {
            const message = errorMessage(error);
            ctx.sessionTransport.send(daemonMessageTypes.sessionCompleted, {
              sessionId: payload.session.id,
              inputId: payload.session.input?.id,
              error: message,
            });
          } finally {
            releaseAccounts();
            ctx.sessionExecutions.complete(payload.session.id, inputId);
            if (ctx.once) {
              ctx.finish("exit");
            }
          }
        })
        .catch((error: unknown) => {
          ctx.sessionExecutions.complete(payload.session.id, inputId);
          const message = errorMessage(error);
          console.error(
            `Session ${payload.session.id} scheduling failed: ${message}`,
          );
        });
    });
}
