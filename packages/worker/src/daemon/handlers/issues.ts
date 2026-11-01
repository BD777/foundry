import { executionHostClient } from "../../execution-host/client.js";
import {
  daemonMessageTypes,
  type EvidenceWorkerRequest,
  type RunSessionPayload,
} from "@bd777/foundry-protocol";
import { evidenceWorkerAction } from "../../evidence-rpc.js";
import { issueEnvironmentAction } from "../../issue-environment-rpc.js";
import { queuePreview, runIssuePreview } from "../../issue-preview.js";
import { recordedIssueCompletion } from "../../issue-recovery.js";
import { runDispatchedIssue } from "../issue-run.js";
import { issueSessionCompletion } from "../../issue-execution.js";
import type { DaemonContext } from "../context.js";
import { reply, type DaemonDispatch } from "../dispatch.js";
import { errorMessage } from "../../utils.js";

// An Issue execution is a session with the issue_execution role: it
// implements the confirmed contract in the Issue's candidate and reports
// through the session. A result recorded earlier, whose report was lost,
// is sent again instead of running the attempt twice.
export function runIssueExecution(
  ctx: DaemonContext,
  payload: RunSessionPayload,
  inputId: string,
): void {
  const session = payload.session;
  const issue = payload.issue;
  const settle = (): void => {
    ctx.sessionExecutions.complete(session.id, inputId);
    if (ctx.once) ctx.finish("exit");
    else ctx.sessionTransport.send(daemonMessageTypes.readyForIssue, {});
  };
  const fail = (error: string): void => {
    ctx.sessionTransport.send(daemonMessageTypes.sessionCompleted, {
      sessionId: session.id,
      inputId: inputId || undefined,
      error,
    });
  };
  if (!issue || issue.id !== session.issueId) {
    fail("The Issue to execute was not sent with its session.");
    settle();
    return;
  }
  const recorded = recordedIssueCompletion(
    session.workspaceId,
    issue.id,
    session.id,
  );
  if (recorded) {
    ctx.sessionTransport.send(
      daemonMessageTypes.sessionCompleted,
      issueSessionCompletion(session.id, inputId || undefined, recorded),
    );
    settle();
    return;
  }
  void ctx.taskScheduler
    .schedule(`issue:${issue.id}`, async () => {
      console.log(
        `Running ${issue.shortId} (${issue.title}) as session ${session.id}`,
      );
      try {
        const workspacePath = ctx.roster.folderFor(session.workspaceId);
        await runDispatchedIssue(
          ctx.serverURL,
          workspacePath,
          ctx.sessionTransport,
          payload,
        );
      } catch (error) {
        // executeIssue reports its own failures once the run started;
        // this is a refusal before it did (an unconfirmed contract).
        fail(errorMessage(error));
      } finally {
        settle();
      }
    })
    .catch((error: unknown) => {
      const message = errorMessage(error);
      console.error(`Issue ${issue.shortId} scheduling failed: ${message}`);
    });
}

/** An Issue's environment (previews, status) and its evidence. */
export function registerIssueHandlers(dispatch: DaemonDispatch): void {
  dispatch
    .on(daemonMessageTypes.issueEnvironment, (envelope, ctx) => {
      const payload = envelope.payload as {
        action: string;
        workspaceId: string;
        issueId: string;
        revision: number;
      };
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.issueEnvironmentResult,
        async () => {
          const sourcePath = ctx.roster.folderFor(payload.workspaceId);
          const host = executionHostClient();
          if (host) {
            const result = await host.issueEnvironment({
              ...payload,
              sourcePath,
            });
            return payload.action === "status"
              ? { ...(result as object), notifiesChanges: true }
              : result;
          }
          if (payload.action === "preview_start") {
            queuePreview(payload.issueId);
            void ctx.taskScheduler
              .schedule(`issue:${payload.issueId}`, () =>
                runIssuePreview(payload.workspaceId, payload.issueId),
              )
              .catch((error) => console.error(String(error)));
            return { status: "preview_queued", revision: payload.revision };
          }
          const result = await issueEnvironmentAction({
            ...payload,
            sourcePath,
          });
          const notifiesChanges = payload.action === "status";
          if (notifiesChanges) ctx.tellEnvironmentChanges();
          return notifiesChanges ? { ...result, notifiesChanges } : result;
        },
      );
    })
    .on(daemonMessageTypes.evidenceRequest, (envelope, ctx) => {
      const payload = envelope.payload as EvidenceWorkerRequest;
      return reply(
        ctx,
        envelope,
        daemonMessageTypes.evidenceResult,
        () =>
          executionHostClient()?.evidence(payload) ??
          evidenceWorkerAction(payload),
        (_message, error) => ({ taskId: payload.taskId, error: String(error) }),
      );
    });
}
