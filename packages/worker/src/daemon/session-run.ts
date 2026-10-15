import type { RunSessionPayload } from "@bd777/foundry-protocol";
import { prepareSessionConnectors } from "../connectors/index.js";
import { prepareClarification } from "../issue-clarification.js";
import type { SessionAmbientEnv } from "../session-ambient.js";
import { keepPersonalAgentInstructions } from "../session-policy.js";
import type { ReliableSessionTransport } from "../transport.js";
import { executeAgentSession, sessionExecution } from "./session-execution.js";
/** One agent turn of the session. */
export async function runAgentSession(
  serverURL: string,
  workspacePath: string,
  transport: ReliableSessionTransport,
  payload: RunSessionPayload,
): Promise<void> {
  const ambient: SessionAmbientEnv = {
    serverURL: serverURL,
    sessionToken: payload.sessionToken ?? "",
    workspaceID: payload.session.workspaceId,
  };
  // An Issue's clarification runs read-only in the workspace with
  // its turn's draft; its answer becomes the reply on the Issue.
  const clarification =
    payload.session.role === "issue_clarification"
      ? await prepareClarification(
          payload.session,
          payload.clarification,
          workspacePath,
          ambient,
        )
      : undefined;
  // Its connectors' tool profiles live while this run does; a run that
  // never returns (a killed worker) leaves them to the next start's reap.
  const accounts = clarification
    ? undefined
    : await prepareSessionConnectors(
        payload.session,
        {
          externalAccounts: payload.externalAccounts,
          deviceConnectors: payload.deviceConnectors,
        },
        {
          serverURL: serverURL,
          log: (message) => console.log(message),
        },
      );
  keepPersonalAgentInstructions(
    payload.session,
    payload.personalAgentInstructions,
  );
  try {
    await executeAgentSession(
      transport,
      clarification?.execution ??
        sessionExecution(workspacePath, payload.session, ambient),
      clarification?.session ?? payload.session,
      payload.credential,
      payload.profile,
      ambient,
      clarification?.settle,
    );
  } finally {
    accounts?.release();
  }
}
