import {
  daemonMessageTypes,
  type RunSessionPayload,
} from "@bd777/foundry-protocol";
import { executeIssue } from "../issue-execution.js";
import {
  profileConfigForSession,
  withDispatchCredential,
} from "../profiles.js";
import { withSessionContextWindow } from "../context-window.js";
import {
  SessionRunTransport,
  issueSessionCompletion,
} from "../issue-execution.js";
import { recordedIssueCompletion } from "../issue-recovery.js";
import type { ReliableSessionTransport } from "../transport.js";

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
  const recorded = recordedIssueCompletion(
    session.workspaceId,
    issue.id,
    session.id,
  );
  if (recorded) {
    transport.send(
      daemonMessageTypes.sessionCompleted,
      issueSessionCompletion(session.id, inputId, recorded),
    );
    return;
  }
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
