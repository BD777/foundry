import type { RunSessionPayload } from "@bd777/foundry-protocol";
import { prepareSessionConnectors } from "../connectors/index.js";
import { prepareSessionTools } from "../skills/session-tools.js";
import { clarificationRole } from "../issue/issue-clarification.js";
import { executeIssue } from "../issue/issue-execution.js";
import type { SessionAmbientEnv } from "../session/session-ambient.js";
import type { SessionRole } from "../session/session-role.js";
import { writePersonalAgentFiles } from "../session/personal-agent-files.js";
import type { ReliableSessionTransport } from "../transport/transport.js";
import { executeAgentSession, sessionExecution } from "./session-execution.js";
import { sessionWork } from "../session-work/supervisor.js";
import { trackScheduledWork } from "./session-work-runtime.js";
/** One agent turn of the session. */
export async function runAgentSession(
  serverURL: string,
  workspacePath: string,
  transport: ReliableSessionTransport,
  payload: RunSessionPayload,
): Promise<void> {
  const { session } = payload;
  sessionWork().attach(session, workspacePath);
  const untrackWork = trackScheduledWork(
    session.id,
    session.input?.timerFire?.id,
  );
  const ambient: SessionAmbientEnv = {
    serverURL: serverURL,
    sessionToken: payload.sessionToken ?? "",
    workspaceID: session.workspaceId,
  };
  const execute = (role: SessionRole) =>
    executeAgentSession(
      transport,
      session,
      role,
      payload.credential,
      payload.profile,
      ambient,
    );
  // Its connectors' tool profiles live while this run does; a run that
  // never returns (a killed worker) leaves them to the next start's reap.
  // The server sends an Issue's sessions none.
  const accounts = await prepareSessionConnectors(
    session,
    {
      externalAccounts: payload.externalAccounts,
      deviceConnectors: payload.deviceConnectors,
      toolPins: payload.toolPins,
    },
    {
      serverURL: serverURL,
      log: (message) => console.log(message),
    },
  );
  // The tool versions its skills were chosen for, kept for this run
  // whatever an update does meanwhile.
  const tools = prepareSessionTools(session.id, payload.toolPins);
  try {
    writePersonalAgentFiles(session, workspacePath, payload.personalAgentFiles);
    // An Issue's clarification runs read-only in the workspace with its
    // turn's draft, and its answer becomes the reply on the Issue; its
    // execution runs in the Issue's candidate and leaves its result there.
    if (session.role === "issue_execution")
      await executeIssue(serverURL, workspacePath, payload, ambient, execute);
    else
      await execute(
        session.role === "issue_clarification"
          ? clarificationRole(
              session,
              payload.clarification,
              workspacePath,
              ambient,
            )
          : {
              prepare: async () => ({
                execution: sessionExecution(workspacePath, session, ambient),
                session,
              }),
            },
      );
  } finally {
    untrackWork();
    accounts.release();
    tools.release();
  }
}
