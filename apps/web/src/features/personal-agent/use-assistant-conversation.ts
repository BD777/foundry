import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentSession,
  PersonalAgentInboxEntry,
} from "@bd777/foundry-protocol";
import {
  cancelAgentSession,
  capturePersonalAgentInbox,
  getAgentSession,
  listPersonalAgentSessions,
  listPersonalAgentInbox,
  actOnPersonalAgentInbox,
  listMessageChannels,
} from "../../api";
import {
  mergeAgentSessionEvent,
  mergeLoadedAgentSession,
} from "../../lib/agent-session-events";
import { serverErrorText } from "../../lib/errors";
import { onStreamEvent } from "../../stream";
import {
  assistantLines,
  assistantWorking,
  isAssistantSession,
  recentAssistantSessions,
  type AssistantLine,
  type assistantRuntime,
} from "./assistant-model";
import { channelSessionIds, isChannelInboxEntry } from "./channel-model";

/** What a new conversation runs on; absent: its computer offers nothing. */
export type AssistantRuntime = NonNullable<ReturnType<typeof assistantRuntime>>;

/** How many of the latest conversations the home page shows. */
const shownSessions = 3;

const sessionEventTypes = [
  "agent_session_created",
  "agent_session_started",
  "agent_session_blocked",
  "agent_session_resumed",
  "agent_session_completed",
] as const;

interface PendingLine {
  clientId: string;
  text: string;
  at: string;
}

function sentInputs(sessions: Iterable<AgentSession>): Set<string> {
  const ids = new Set<string>();
  for (const session of sessions) {
    if (session.input?.id) ids.add(session.input.id);
    for (const event of session.events ?? [])
      if (event.message?.kind === "user") ids.add(event.message.id);
  }
  return ids;
}

/**
 * The conversation with the assistant: its latest sessions in the
 * assistant's own project and in the ones it lived in before it moved
 * (formerWorkspaceIds), read once and then followed on the stream. A
 * message continues the latest session of the current project; after a
 * quiet spell, or one that ended badly, it starts a new one there (§7). The
 * server makes the person's sessions there the assistant's (role
 * personal_agent).
 */
export function useAssistantConversation(
  assistantId: string | undefined,
  workspaceId: string,
  formerWorkspaceIds: readonly string[] = [],
) {
  const former = formerWorkspaceIds.join("\n");
  const [sessions, setSessions] = useState<Map<string, AgentSession>>(
    () => new Map(),
  );
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<PendingLine[]>([]);
  const [inbox, setInbox] = useState<PersonalAgentInboxEntry[]>([]);
  // Message channels' sessions live in the assistant's home too; the
  // conversation leaves them out. Unreadable channels leave nothing out.
  const [channelSessions, setChannelSessions] = useState<Set<string>>(
    () => new Set(),
  );
  const readChannels = useCallback(
    () =>
      listMessageChannels(assistantId).then(
        (list) => channelSessionIds(list),
        () => new Set<string>(),
      ),
    [assistantId],
  );
  const [inboxError, setInboxError] = useState("");
  const [retryingInboxId, setRetryingInboxId] = useState<string>();
  const retryKeys = useRef(new Map<string, string>());
  const held = useRef(sessions);
  held.current = sessions;
  // The sessions read in full. One learned otherwise (a create's or send's
  // reply, a stream announcement) comes without events, and its first
  // input's event is never streamed: only a read has it.
  const readInFull = useRef(new Set<string>());

  const upsert = useCallback((session: AgentSession) => {
    setSessions((current) => {
      const next = new Map(current);
      next.set(
        session.id,
        mergeLoadedAgentSession(current.get(session.id), session),
      );
      return next;
    });
  }, []);

  const read = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const [current, received, channels, ...earlier] = await Promise.all([
        listPersonalAgentSessions(workspaceId),
        listPersonalAgentInbox(assistantId),
        readChannels(),
        // A project it left may be gone; its conversations go with it.
        ...former
          .split("\n")
          .filter(Boolean)
          .map((id) => listPersonalAgentSessions(id).catch(() => [])),
      ]);
      setInbox(received);
      setChannelSessions(channels);
      const listed = [...current!, ...earlier.flat()];
      const recent = recentAssistantSessions(
        listed,
        shownSessions,
        new Set([...channels, ...channelSessionIds(undefined, received)]),
      );
      const loaded = await Promise.all(
        recent.map((session) => getAgentSession(session.id)),
      );
      for (const session of loaded) readInFull.current.add(session.id);
      setSessions((current) => {
        const next = new Map<string, AgentSession>();
        for (const session of loaded)
          next.set(
            session.id,
            mergeLoadedAgentSession(current.get(session.id), session),
          );
        return next;
      });
      setState("ready");
      setError("");
    } catch (reason) {
      setError(serverErrorText(reason));
      setState((current) => (current === "ready" ? current : "failed"));
    }
  }, [assistantId, workspaceId, former, readChannels]);

  useEffect(() => {
    setState("loading");
    setSessions(new Map());
    readInFull.current = new Set();
    void read();
  }, [read]);

  const ownInbox = useMemo(
    () => inbox.filter((entry) => !isChannelInboxEntry(entry)),
    [inbox],
  );
  const excluded = useMemo(
    () => new Set([...channelSessions, ...channelSessionIds(undefined, inbox)]),
    [channelSessions, inbox],
  );
  const waitingInbox = useMemo(
    () =>
      ownInbox
        .filter((entry) =>
          ["pending", "waiting", "dispatching"].includes(entry.status),
        )
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    [ownInbox],
  );
  const failedInbox = useMemo(
    () =>
      ownInbox.filter(
        (entry) =>
          entry.status !== "cancelled" &&
          ["failed", "canceled"].includes(entry.resultStatus ?? ""),
      ),
    [ownInbox],
  );
  const needsInboxRefresh = ownInbox.some(
    (entry) =>
      ["pending", "waiting", "dispatching"].includes(entry.status) ||
      (entry.status === "delivered" && !entry.resultStatus),
  );
  useEffect(() => {
    if (!needsInboxRefresh) return;
    const timer = window.setInterval(() => {
      void listPersonalAgentInbox(assistantId).then(
        (items) => {
          setInbox(items);
          setInboxError("");
        },
        (reason) => setInboxError(serverErrorText(reason)),
      );
    }, 3000);
    return () => window.clearInterval(timer);
  }, [assistantId, needsInboxRefresh]);

  useEffect(() => {
    if (!workspaceId) return;
    const stops = sessionEventTypes.map((type) =>
      onStreamEvent(
        type,
        (session) => {
          if (!isAssistantSession(session)) return;
          // A session new to the page may be a channel's: learn the
          // channels' sessions again.
          if (!held.current.has(session.id))
            void readChannels().then((ids) => {
              if (ids.size) setChannelSessions(ids);
            });
          upsert(session);
        },
        { workspaceId, onResync: () => void read() },
      ),
    );
    stops.push(
      onStreamEvent("agent_session_event", (event) => {
        if (!held.current.has(event.sessionId)) return;
        setSessions((current) => {
          const session = current.get(event.sessionId);
          if (!session) return current;
          const next = new Map(current);
          next.set(session.id, {
            ...session,
            events: mergeAgentSessionEvent(session.events, event),
          });
          return next;
        });
      }),
    );
    return () => stops.forEach((stop) => stop());
  }, [workspaceId, read, readChannels, upsert]);

  useEffect(() => {
    for (const id of sessions.keys()) {
      if (readInFull.current.has(id)) continue;
      readInFull.current.add(id);
      const reading = readInFull.current;
      getAgentSession(id).then(
        (session) =>
          setSessions((current) => {
            const shown = current.get(id);
            if (!shown) return current;
            const next = new Map(current);
            next.set(id, mergeLoadedAgentSession(shown, session));
            return next;
          }),
        () => reading.delete(id),
      );
    }
  }, [sessions]);

  const ordered = useMemo(
    () =>
      recentAssistantSessions([...sessions.values()], shownSessions, excluded),
    [sessions, excluded],
  );
  const shownInputs = useMemo(() => sentInputs(sessions.values()), [sessions]);
  // A message the conversation shows is no longer pending: kept, it would
  // come back at the end whenever its input stopped being the latest.
  useEffect(() => {
    setPending((current) => {
      const waiting = current.filter((line) => !shownInputs.has(line.clientId));
      return waiting.length === current.length ? current : waiting;
    });
  }, [shownInputs]);
  const lines = useMemo<Array<AssistantLine & { clientId?: string }>>(
    () => [
      ...assistantLines(ordered),
      ...waitingInbox
        .filter((entry) => !shownInputs.has(entry.inputId))
        .map((entry) => ({
          id: `received:${entry.id}`,
          clientId: entry.messageId,
          role: "person" as const,
          text: entry.text,
          at: entry.createdAt,
        })),
      ...pending
        .filter((line) => !shownInputs.has(line.clientId))
        .map((line) => ({
          id: `pending:${line.clientId}`,
          clientId: line.clientId,
          role: "person" as const,
          text: line.text,
          at: line.at,
        })),
    ],
    [ordered, pending, shownInputs, waitingInbox],
  );
  const latest = ordered[ordered.length - 1];

  return {
    state,
    error,
    lines,
    waitingInbox,
    failedInbox,
    inboxError,
    retryingInboxId,
    async retryInbox(entry: PersonalAgentInboxEntry): Promise<void> {
      if (retryingInboxId) return;
      const requestId = retryKeys.current.get(entry.id) ?? crypto.randomUUID();
      retryKeys.current.set(entry.id, requestId);
      setRetryingInboxId(entry.id);
      setInboxError("");
      try {
        const saved = await actOnPersonalAgentInbox(assistantId, entry.id, {
          action: "retry",
          revision: entry.revision,
          requestId,
        });
        setInbox((items) => [
          ...items.filter(
            (item) => item.id !== entry.id && item.id !== saved.id,
          ),
          saved,
        ]);
        retryKeys.current.delete(entry.id);
      } catch (reason) {
        setInboxError(serverErrorText(reason));
      } finally {
        setRetryingInboxId(undefined);
      }
    },
    working: assistantWorking(ordered),
    /** The latest session: queued, it may wait for its offline computer. */
    latestSession: latest,
    /** The latest turn: changes when a message starts a new one. */
    latestTurnId: latest ? `${latest.id}:${latest.input?.id ?? ""}` : "",
    retry: read,
    async send(text: string, clientId: string): Promise<void> {
      setPending((current) => [
        ...current.filter((line) => line.clientId !== clientId),
        { clientId, text, at: new Date().toISOString() },
      ]);
      try {
        const receipt = await capturePersonalAgentInbox(assistantId, {
          text,
          messageId: clientId,
        });
        setInbox((current) => [
          ...current.filter((entry) => entry.id !== receipt.id),
          receipt,
        ]);
        setPending((current) =>
          current.filter((line) => line.clientId !== clientId),
        );
        void read();
      } catch (reason) {
        setPending((current) =>
          current.filter((line) => line.clientId !== clientId),
        );
        throw reason;
      }
    },
    /** Stops the reply being written, not the work it handed off. */
    async stopReply(): Promise<void> {
      if (latest) upsert(await cancelAgentSession(latest.id));
    },
  };
}
