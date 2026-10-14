import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentSession,
  PersonalAgent,
  PersonalAgentOverview,
  PersonalAgentProposal,
  PersonalAgentTask,
} from "@bd777/foundry-protocol";
import {
  acceptPersonalAgentProposal,
  declinePersonalAgentProposal,
  getPersonalAgent,
  isPersonalAgentUnavailable,
  listPersonalAgentProposals,
  listPersonalAgentTasks,
  resumePersonalAgent,
  stopPersonalAgent,
  stopPersonalAgentTask,
} from "../../api";
import { serverErrorText } from "../../lib/errors";
import { onStreamEvent } from "../../stream";

export type AssistantLoad =
  | { state: "loading" }
  /** The server has no assistant (an older server). */
  | { state: "unavailable" }
  | { state: "failed"; message: string }
  | { state: "ready"; overview: PersonalAgentOverview };

/** What the assistant's sessions do changes its proposals and tasks. */
const sessionEventTypes = [
  "agent_session_created",
  "agent_session_started",
  "agent_session_blocked",
  "agent_session_resumed",
  "agent_session_completed",
] as const;

const refreshDelayMs = 400;

/**
 * The person's assistant: its state, the proposals waiting for them and the
 * work it follows up. Read when shown, and again when one of its sessions
 * (or a session doing its work) starts or ends, or the stream missed events.
 */
export function useAssistant() {
  const [load, setLoad] = useState<AssistantLoad>({ state: "loading" });
  const [proposals, setProposals] = useState<PersonalAgentProposal[]>([]);
  const [tasks, setTasks] = useState<PersonalAgentTask[]>([]);
  const [listsError, setListsError] = useState("");
  const agent = load.state === "ready" ? load.overview.agent : undefined;
  const workspaceId = agent?.workspaceId ?? "";
  const watched = useRef({ workspaceId, sessions: new Set<string>() });
  watched.current = {
    workspaceId,
    sessions: new Set(tasks.flatMap((task) => task.sessionId ?? [])),
  };

  const readOverview = useCallback(async () => {
    try {
      const overview = await getPersonalAgent();
      setLoad({ state: "ready", overview });
      return overview;
    } catch (error) {
      setLoad(
        isPersonalAgentUnavailable(error)
          ? { state: "unavailable" }
          : { state: "failed", message: serverErrorText(error) },
      );
      return undefined;
    }
  }, []);

  const readLists = useCallback(async () => {
    try {
      const [nextProposals, nextTasks] = await Promise.all([
        listPersonalAgentProposals(),
        listPersonalAgentTasks(),
      ]);
      setProposals(nextProposals);
      setTasks(nextTasks);
      setListsError("");
    } catch (error) {
      setListsError(serverErrorText(error));
    }
  }, []);

  const reload = useCallback(async () => {
    const overview = await readOverview();
    if (overview?.agent) await readLists();
  }, [readOverview, readLists]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void reload(), refreshDelayMs);
    };
    const stops = sessionEventTypes.map((type) =>
      onStreamEvent(
        type,
        (session: AgentSession) => {
          const { workspaceId: home, sessions } = watched.current;
          if (
            (home && session.workspaceId === home) ||
            sessions.has(session.id)
          )
            schedule();
        },
        { onResync: schedule },
      ),
    );
    return () => {
      window.clearTimeout(timer);
      stops.forEach((stop) => stop());
    };
  }, [reload]);

  const replaceAgent = (next: PersonalAgent) =>
    setLoad((current) =>
      current.state === "ready"
        ? { state: "ready", overview: { ...current.overview, agent: next } }
        : current,
    );

  return {
    load,
    agent,
    proposals,
    tasks,
    listsError,
    reload,
    replaceAgent,
    /** Stops everything; answers the server's fixed reply. */
    async stopAll(): Promise<string> {
      const answer = await stopPersonalAgent();
      replaceAgent(answer.agent);
      await readLists();
      return answer.reply;
    },
    async resume(): Promise<string> {
      const answer = await resumePersonalAgent();
      replaceAgent(answer.agent);
      await readLists();
      return answer.reply;
    },
    async answer(
      proposal: PersonalAgentProposal,
      accept: boolean,
    ): Promise<void> {
      const decided = accept
        ? await acceptPersonalAgentProposal(proposal.id)
        : await declinePersonalAgentProposal(proposal.id);
      setProposals((current) =>
        current.map((item) => (item.id === decided.id ? decided : item)),
      );
    },
    async stopTask(task: PersonalAgentTask): Promise<void> {
      await stopPersonalAgentTask(task.id);
      await readLists();
    },
  };
}

export type AssistantController = ReturnType<typeof useAssistant>;
