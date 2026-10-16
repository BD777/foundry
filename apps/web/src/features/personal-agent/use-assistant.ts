import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentSession,
  PersonalAgent,
  PersonalAgentListItem,
  PersonalAgentOverview,
  PersonalAgentProposal,
  PersonalAgentTask,
} from "@bd777/foundry-protocol";
import {
  acceptPersonalAgentProposal,
  declinePersonalAgentProposal,
  deletePersonalAgentListItem,
  fillPersonalAgentTimezone,
  getPersonalAgent,
  isPersonalAgentUnavailable,
  listPersonalAgentList,
  listPersonalAgentProposals,
  listPersonalAgentTasks,
  resumePersonalAgent,
  stopPersonalAgent,
  stopPersonalAgentTask,
  updatePersonalAgentListItem,
} from "../../api";
import { serverErrorText } from "../../lib/errors";
import { onStreamEvent } from "../../stream";
import { browserTimezone } from "./assistant-model";
import { listItemEdit, startOfLocalDay } from "./person-list-model";

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
 * The person's assistant: its state, the proposals waiting for them, the
 * work it follows up and the person's own list. Read when shown, and again when one of its sessions
 * (or a session doing its work) starts or ends, or the stream missed events.
 */
export function useAssistant() {
  const [load, setLoad] = useState<AssistantLoad>({ state: "loading" });
  const [proposals, setProposals] = useState<PersonalAgentProposal[]>([]);
  const [tasks, setTasks] = useState<PersonalAgentTask[]>([]);
  const [listsError, setListsError] = useState("");
  const [listItems, setListItems] = useState<PersonalAgentListItem[]>([]);
  const [listItemsError, setListItemsError] = useState("");
  const agent = load.state === "ready" ? load.overview.agent : undefined;
  const workspaceId = agent?.workspaceId ?? "";
  const watched = useRef({ workspaceId, sessions: new Set<string>() });
  watched.current = {
    workspaceId,
    sessions: new Set(tasks.flatMap((task) => task.sessionId ?? [])),
  };

  // An assistant without a time zone gets this browser's, offered once
  // per page: the server keeps one the person chose.
  const timezoneOffered = useRef(false);
  const withTimezone = useCallback(
    async (overview: PersonalAgentOverview): Promise<PersonalAgentOverview> => {
      const zone = browserTimezone();
      if (!overview.agent || overview.agent.settings.timezone || !zone)
        return overview;
      if (timezoneOffered.current) return overview;
      timezoneOffered.current = true;
      try {
        return { ...overview, agent: await fillPersonalAgentTimezone(zone) };
      } catch (error) {
        console.warn("assistant time zone not saved", error);
        return overview;
      }
    },
    [],
  );

  const readOverview = useCallback(async () => {
    try {
      const overview = await withTimezone(await getPersonalAgent());
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
  }, [withTimezone]);

  // The person's list: open items, and those closed since the start of
  // today. Read on its own so a failure leaves proposals and tasks shown.
  const readListItems = useCallback(async () => {
    try {
      setListItems(
        await listPersonalAgentList(startOfLocalDay().toISOString()),
      );
      setListItemsError("");
    } catch (error) {
      setListItemsError(serverErrorText(error));
    }
  }, []);

  const readWork = useCallback(async () => {
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

  const readLists = useCallback(async () => {
    await Promise.all([readWork(), readListItems()]);
  }, [readWork, readListItems]);

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
    listItems,
    listItemsError,
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
    /** Ticks an item done, or reopens it. */
    async tickItem(item: PersonalAgentListItem, done: boolean): Promise<void> {
      await updatePersonalAgentListItem(item.id, {
        status: done ? "done" : "open",
      });
      await readListItems();
    },
    /** Saves the person's words; nothing is sent when nothing changed. */
    async editItem(
      item: PersonalAgentListItem,
      draft: { text: string; when: string },
    ): Promise<void> {
      const input = listItemEdit(item, draft);
      if (Object.keys(input).length === 0) return;
      await updatePersonalAgentListItem(item.id, input);
      await readListItems();
    },
    async deleteItem(item: PersonalAgentListItem): Promise<void> {
      await deletePersonalAgentListItem(item.id);
      await readListItems();
    },
  };
}

export type AssistantController = ReturnType<typeof useAssistant>;
