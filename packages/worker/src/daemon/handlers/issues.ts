import { executionHostClient } from "../../execution-host/fleet.js";
import {
  daemonMessageTypes,
  type EvidenceWorkerRequest,
} from "@bd777/foundry-protocol";
import { evidenceWorkerAction } from "../../issue/evidence/evidence-rpc.js";
import { issueEnvironmentAction } from "../../issue/issue-environment-rpc.js";
import { reply, type DaemonDispatch } from "../dispatch.js";

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
          if (host) return host.issueEnvironment({ ...payload, sourcePath });
          if (payload.action === "preview_start")
            return ctx.executions.preview(payload);
          const result = await issueEnvironmentAction({
            ...payload,
            sourcePath,
          });
          if (payload.action === "status") ctx.tellEnvironmentChanges();
          return result;
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
