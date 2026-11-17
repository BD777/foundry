import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentSession,
  ChatAttachment,
  PersonalAgentInboxEntry,
} from "@bd777/foundry-protocol";
import {
  actOnPersonalAgentInbox,
  cancelAgentSession,
  capturePersonalAgentInbox,
  getAgentSession,
  listPersonalAgentSessions,
  listPersonalAgentInbox,
  listMessageChannels,
} from "../../api";
import {
  mergeAgentSessionEvent,
  mergeLoadedAgentSession,
} from "../../lib/agent-session-events";
import { serverErrorText } from "../../lib/errors";
import type { ConversationAnnotation } from "../../components/conversation/annotations";
import { sentAnnotation } from "../../components/conversation/annotations";
import {
  receivedAnnotations,
  sentPromptText,
} from "../../components/conversation/received-annotations";
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

/** How long a failed read waits before it is made again (DEV-287). */
export const failedReadRetryMs = 5000;

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
  attachments: ChatAttachment[];
  annotations?: ConversationAnnotation[];
}

/**
 * A read that began before the stream changed the session answers with an
 * older state of it: the stream's state (status, answer, activity) wins over
 * the read's, while what only a read brings (events, the first input) is
 * still taken from it (see mergeLoadedAgentSession).
 */
function readAsOf(
  shown: AgentSession | undefined,
  loaded: AgentSession,
  streamedAt: ReadonlyMap<string, number>,
  readStartedAt: number,
): AgentSession {
  if (!shown || (streamedAt.get(loaded.id) ?? -Infinity) < readStartedAt)
    return loaded;
  return {
    ...loaded,
    status: shown.status,
    completedAt: shown.completedAt,
    response: shown.response,
    error: shown.error,
    lastActivityAt: shown.lastActivityAt,
  };
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
  // Every session of the assistant's projects, not only the three whose
  // transcripts the home shows: handoff rows name the helpers it started
  // and messaged (DEV-250).
  const [knownSessions, setKnownSessions] = useState<AgentSession[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [error, setError] = useState("");
  // Counts failed reads, so a failure that leaves the page failed is
  // scheduled again (see the effect below).
  const [failedReads, setFailedReads] = useState(0);
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
  const held = useRef(sessions);
  held.current = sessions;
  // The sessions read in full. One learned otherwise (a create's or send's
  // reply, a stream announcement) comes without events, and its first
  // input's event is never streamed: only a read has it.
  const readInFull = useRef(new Set<string>());
  // When the stream last changed each session (see changedSince).
  const streamedAt = useRef(new Map<string, number>());

  const upsert = useCallback((session: AgentSession) => {
    streamedAt.current.set(session.id, Date.now());
    setSessions((current) => {
      const next = new Map(current);
      next.set(
        session.id,
        mergeLoadedAgentSession(current.get(session.id), session),
      );
      return next;
    });
    setKnownSessions((current) => {
      const index = current.findIndex((entry) => entry.id === session.id);
      if (index < 0) return [...current, session];
      const next = [...current];
      next[index] = mergeLoadedAgentSession(current[index], session);
      return next;
    });
  }, []);

  const read = useCallback(async () => {
    if (!workspaceId) return;
    const startedAt = Date.now();
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
      setKnownSessions(listed);
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
        for (const session of loaded) {
          const shown = current.get(session.id);
          next.set(
            session.id,
            mergeLoadedAgentSession(
              shown,
              readAsOf(shown, session, streamedAt.current, startedAt),
            ),
          );
        }
        return next;
      });
      setState("ready");
      setError("");
    } catch (reason) {
      setError(serverErrorText(reason));
      setFailedReads((count) => count + 1);
      setState((current) => (current === "ready" ? current : "failed"));
    }
  }, [assistantId, workspaceId, former, readChannels]);

  useEffect(() => {
    setState("loading");
    setSessions(new Map());
    readInFull.current = new Set();
    void read();
  }, [read]);

  // A page that could not read its conversation (the network was down)
  // reads it again by itself: the stream resumes without a resync when the
  // outage was short, so nothing else would.
  useEffect(() => {
    if (state !== "failed") return;
    const timer = window.setTimeout(() => void read(), failedReadRetryMs);
    return () => window.clearTimeout(timer);
  }, [state, failedReads, read]);

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
  const needsInboxRefresh = ownInbox.some(
    (entry) =>
      ["pending", "waiting", "dispatching"].includes(entry.status) ||
      (entry.status === "delivered" && !entry.resultStatus),
  );
  useEffect(() => {
    if (!needsInboxRefresh) return;
    const timer = window.setInterval(() => {
      // A failed read keeps the messages already shown; the next pass
      // retries.
      void listPersonalAgentInbox(assistantId).then(setInbox, () => {});
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
      const startedAt = Date.now();
      getAgentSession(id).then(
        (session) =>
          setSessions((current) => {
            const shown = current.get(id);
            if (!shown) return current;
            const next = new Map(current);
            next.set(
              id,
              mergeLoadedAgentSession(
                shown,
                readAsOf(shown, session, streamedAt.current, startedAt),
              ),
            );
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
          text: sentPromptText(entry.text, entry.annotations),
          attachments: entry.attachments,
          annotations: receivedAnnotations(entry.annotations),
          at: entry.createdAt,
        })),
      ...pending
        .filter((line) => !shownInputs.has(line.clientId))
        .map((line) => ({
          id: `pending:${line.clientId}`,
          clientId: line.clientId,
          role: "person" as const,
          text: sentPromptText(line.text, line.annotations),
          attachments: line.attachments,
          annotations: line.annotations,
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
    /** Every session of the assistant's projects, for handoff rows. */
    knownSessions,
    /** The person's saved messages, to match a stopped turn's input. */
    inbox: ownInbox,
    waitingInbox,
    working: assistantWorking(ordered),
    /** The latest session: queued, it may wait for its offline computer. */
    latestSession: latest,
    /** The latest turn: changes when a message starts a new one. */
    latestTurnId: latest ? `${latest.id}:${latest.input?.id ?? ""}` : "",
    retry: read,
    async send(
      text: string,
      clientId: string,
      attachments: ChatAttachment[] = [],
      annotations: ConversationAnnotation[] = [],
    ): Promise<void> {
      setPending((current) => [
        ...current.filter((line) => line.clientId !== clientId),
        {
          annotations,
          at: new Date().toISOString(),
          attachments,
          clientId,
          text,
        },
      ]);
      try {
        const receipt = await capturePersonalAgentInbox(assistantId, {
          text,
          messageId: clientId,
          attachments: attachments.length ? attachments : undefined,
          annotations: annotations.length
            ? annotations.map(sentAnnotation)
            : undefined,
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
    /**
     * One more attempt of a saved message whose turn ended without an
     * answer: the same inbox retry the Needs you item offers (DEV-267).
     */
    async retryInbox(entry: PersonalAgentInboxEntry): Promise<void> {
      const updated = await actOnPersonalAgentInbox(assistantId, entry.id, {
        action: "retry",
        revision: entry.revision,
        requestId: crypto.randomUUID(),
      });
      setInbox((current) => [
        ...current.filter((item) => item.id !== updated.id),
        updated,
      ]);
      void read();
    },
    /** Stops the reply being written, not the work it handed off. */
    async stopReply(): Promise<void> {
      if (latest) upsert(await cancelAgentSession(latest.id));
    },
  };
}
