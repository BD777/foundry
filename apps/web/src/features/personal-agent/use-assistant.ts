import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentSession,
  PersonalAgent,
  PersonalAgentItem,
  PersonalAgentOperation,
  PersonalAgentOverview,
  PersonalAgentProposal,
  PersonalAgentTask,
} from "@bd777/foundry-protocol";
import {
  acceptPersonalAgentProposal,
  declinePersonalAgentProposal,
  fillPersonalAgentTimezone,
  getPersonalAgent,
  listPersonalAgentOperations,
  listPersonalAgentProposals,
  listPersonalAgentTasks,
  resumePersonalAgent,
  stopPersonalAgent,
  stopPersonalAgentTask,
} from "../../api";
import { serverErrorText } from "../../lib/errors";
import { onStreamEvent } from "../../stream";
import { assistantSessionEventTypes } from "./assistant-session-events";
import { browserTimezone } from "./assistant-model";
import { startOfLocalDay } from "./items-model";
import { personalItemActions, usePersonalItems } from "./use-personal-items";

export type AssistantLoad =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "ready"; overview: PersonalAgentOverview };

const refreshDelayMs = 400;

/** The open 「事项」 (all of them: the card's count and the helpers they own). */
const openItemsQuery = { view: "open", limit: 200 } as const;

/**
 * The person's assistant: its state, the proposals waiting for them, the
 * work it follows up and the person's 「事项」. Read when shown, and again when
 * one of its sessions (or a session doing its work) starts or ends, or the
 * stream missed events.
 */
export function useAssistant(assistantId?: string) {
  const [load, setLoad] = useState<AssistantLoad>({ state: "loading" });
  const [proposals, setProposals] = useState<PersonalAgentProposal[]>([]);
  const [tasks, setTasks] = useState<PersonalAgentTask[]>([]);
  const [operations, setOperations] = useState<PersonalAgentOperation[]>([]);
  const [listsError, setListsError] = useState("");
  const openItems = usePersonalItems(assistantId, openItemsQuery);
  const todayItems = usePersonalItems(assistantId, {
    view: "finished",
    from: startOfLocalDay().toISOString(),
    limit: 200,
  });
  const agent = load.state === "ready" ? load.overview.agent : undefined;
  const workspaceId = agent?.workspaceId ?? "";
  const watched = useRef({ workspaceId, sessions: new Set<string>() });
  watched.current = {
    workspaceId,
    sessions: new Set([
      ...tasks.flatMap((task) => task.sessionId ?? []),
      ...operations.flatMap((op) => op.sessionId ?? []),
    ]),
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
        return {
          ...overview,
          agent: await fillPersonalAgentTimezone(assistantId, zone),
        };
      } catch (error) {
        console.warn("assistant time zone not saved", error);
        return overview;
      }
    },
    [assistantId],
  );

  const readOverview = useCallback(async () => {
    try {
      const overview = await withTimezone(await getPersonalAgent(assistantId));
      setLoad({ state: "ready", overview });
      return overview;
    } catch (error) {
      setLoad({ state: "failed", message: serverErrorText(error) });
      return undefined;
    }
  }, [assistantId, withTimezone]);

  const readWork = useCallback(async () => {
    try {
      const [nextProposals, nextTasks] = await Promise.all([
        listPersonalAgentProposals(assistantId),
        listPersonalAgentTasks(assistantId),
      ]);
      setProposals(nextProposals);
      setTasks(nextTasks);
      setListsError("");
    } catch (error) {
      setListsError(serverErrorText(error));
    }
  }, [assistantId]);

  const readLists = useCallback(async () => {
    await Promise.all([
      readWork(),
      listPersonalAgentOperations(assistantId)
        .then(setOperations)
        .catch((e) => setListsError(serverErrorText(e))),
    ]);
  }, [assistantId, readWork]);

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
    const stops = assistantSessionEventTypes.map((type) =>
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
    operations,
    listsError,
    /** The person's open 「事项」 (all of them, for the count and the helpers). */
    openItems,
    /** Items updated since the start of today: where the closed ones of today come from. */
    todayItems,
    reload,
    replaceAgent,
    /** Pauses new dispatch and requests execution stops; receipts remain separate. */
    async stopAll(): Promise<string> {
      const answer = await stopPersonalAgent(assistantId);
      replaceAgent(answer.agent);
      await readLists();
      return answer.reply;
    },
    async resume(): Promise<string> {
      const answer = await resumePersonalAgent(assistantId);
      replaceAgent(answer.agent);
      await readLists();
      return answer.reply;
    },
    async answer(
      proposal: PersonalAgentProposal,
      accept: boolean,
    ): Promise<void> {
      const decided = accept
        ? await acceptPersonalAgentProposal(assistantId, proposal.id)
        : await declinePersonalAgentProposal(assistantId, proposal.id);
      setProposals((current) =>
        current.map((item) => (item.id === decided.id ? decided : item)),
      );
    },
    async stopTask(task: PersonalAgentTask): Promise<void> {
      await stopPersonalAgentTask(assistantId, task.id);
      await readLists();
    },
    /** Ticks an 「事项」 done, or reopens it; both lists of items show the change. */
    async setItemDone(item: PersonalAgentItem, done: boolean): Promise<void> {
      await personalItemActions.setStatus(
        assistantId,
        item,
        done ? "done" : "open",
      );
      await Promise.all([openItems.reload(), todayItems.reload()]);
    },
  };
}

export type AssistantController = ReturnType<typeof useAssistant>;
