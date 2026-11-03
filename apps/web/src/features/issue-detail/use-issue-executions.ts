import { useCallback, useEffect, useState } from "react";
import type { AgentSession, Issue } from "@bd777/foundry-protocol";
import { listIssueExecutions } from "../../api";
import {
  mergeAgentSessionEvent,
  mergeLoadedAgentSession,
} from "../../lib/agent-session-events";
import { useStreamEvent } from "../../stream";

export interface IssueExecutions {
  /** Its latest issue_execution sessions with their events, oldest first. */
  executions: AgentSession[];
  error: string;
}

/**
 * An Issue's executions as its conversation shows them: read in one request
 * when its current execution starts or ends, and their events followed live.
 */
export function useIssueExecutions(issue: Issue): IssueExecutions {
  const [state, setState] = useState<IssueExecutions>({
    executions: [],
    error: "",
  });
  const { id } = issue;
  const read = useCallback(async () => {
    try {
      const loaded = await listIssueExecutions(id);
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
  }, [id]);
  const run = issue.run && `${issue.run.id}:${issue.run.status}`;
  useEffect(() => {
    void read();
  }, [read, run, issue.status]);
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
