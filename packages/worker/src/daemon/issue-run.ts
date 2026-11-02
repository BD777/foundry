import type { RunSessionPayload } from "@bd777/foundry-protocol";
import { executeIssue, SessionRunTransport } from "../issue/issue-execution.js";
import {
  profileConfigForSession,
  withDispatchCredential,
} from "../harness/profiles.js";
import { withSessionContextWindow } from "../harness/context-window.js";
import type { ReliableSessionTransport } from "../transport/transport.js";

/**
 * An Issue execution: a session with the issue_execution role implements the
 * confirmed contract in the Issue's candidate and reports through the
 * session. A refusal before it started (an unconfirmed contract) throws.
 */
export async function runDispatchedIssue(
  serverURL: string,
  workspacePath: string,
  transport: ReliableSessionTransport,
  payload: RunSessionPayload,
): Promise<void> {
  const { session, issue } = payload;
  const inputId = session.input?.id;
  if (!issue || issue.id !== session.issueId)
    throw new Error("The Issue to execute was not sent with its session.");
  const profile =
    issue.runtime === "mock"
      ? undefined
      : await withSessionContextWindow(
          withDispatchCredential(
            profileConfigForSession(workspacePath, session, payload.profile),
            payload.credential,
          ),
          session,
        );
  await executeIssue(
    serverURL,
    workspacePath,
    issue,
    new SessionRunTransport(transport, session.id, inputId || undefined),
    undefined,
    session.skillRefs ?? [],
    payload.userFiles === "readable" ? "readable" : "hidden",
    session.id,
    profile,
    {
      serverURL: serverURL,
      sessionToken: payload.sessionToken ?? "",
      workspaceID: session.workspaceId,
    },
    session.workspaceDraftSkills,
  );
}
