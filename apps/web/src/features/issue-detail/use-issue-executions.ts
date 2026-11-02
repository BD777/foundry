import { useCallback, useEffect, useState } from "react";
import type { AgentSession, Issue } from "@bd777/foundry-protocol";
import { getAgentSession, listIssueSessions } from "../../api";
import {
  mergeAgentSessionEvent,
  mergeLoadedAgentSession,
} from "../../lib/agent-session-events";
import { useStreamEvent } from "../../stream";

/** How many of an Issue's latest executions its conversation shows. */
export const shownIssueExecutions = 20;

export interface IssueExecutions {
  /** Its issue_execution sessions with their events, oldest first. */
  executions: AgentSession[];
  error: string;
}

/**
 * An Issue's executions as its conversation shows them: read when its
 * current execution starts or ends, and their events followed live.
 */
export function useIssueExecutions(issue: Issue): IssueExecutions {
  const [state, setState] = useState<IssueExecutions>({
    executions: [],
    error: "",
  });
  const { id, workspaceId } = issue;
  const read = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const sessions = await listIssueSessions(workspaceId, id);
      const loaded = await Promise.all(
        sessions
          .filter((session) => session.role === "issue_execution")
          .slice(-shownIssueExecutions)
          .map((session) => getAgentSession(session.id)),
      );
      setState((current) => ({
        executions: loaded.map((session) =>
          mergeLoadedAgentSession(
            current.executions.find((shown) => shown.id === session.id),
            session,
          ),
        ),
        error: "",
      }));
    } catch (reason) {
      setState((current) => ({ ...current, error: String(reason) }));
    }
  }, [id, workspaceId]);
  const run = issue.run && `${issue.run.id}:${issue.run.status}`;
  useEffect(() => {
    void read();
  }, [read, run]);
  useStreamEvent(
    "agent_session_event",
    (event) =>
      setState((current) =>
        current.executions.some((session) => session.id === event.sessionId)
          ? {
              ...current,
              executions: current.executions.map((session) =>
                session.id === event.sessionId
                  ? {
                      ...session,
                      events: mergeAgentSessionEvent(session.events, event),
                    }
                  : session,
              ),
            }
          : current,
      ),
    { onResync: () => void read() },
  );
  return state;
}
