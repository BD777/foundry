import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentSession } from "@bd777/foundry-protocol";
import {
  cancelAgentSession,
  createAgentSession,
  getAgentSession,
  listPersonalAgentSessions,
  sendAgentSessionMessage,
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
  continuedSession,
  isAssistantSession,
  recentAssistantSessions,
  type AssistantLine,
  type assistantRuntime,
} from "./assistant-model";

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
      const [current, ...earlier] = await Promise.all([
        listPersonalAgentSessions(workspaceId),
        // A project it left may be gone; its conversations go with it.
        ...former
          .split("\n")
          .filter(Boolean)
          .map((id) => listPersonalAgentSessions(id).catch(() => [])),
      ]);
      const listed = [...current!, ...earlier.flat()];
      const recent = recentAssistantSessions(listed, shownSessions);
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
  }, [workspaceId, former]);

  useEffect(() => {
    setState("loading");
    setSessions(new Map());
    readInFull.current = new Set();
    void read();
  }, [read]);

  useEffect(() => {
    if (!workspaceId) return;
    const stops = sessionEventTypes.map((type) =>
      onStreamEvent(
        type,
        (session) => {
          if (isAssistantSession(session)) upsert(session);
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
  }, [workspaceId, read, upsert]);

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
    () => recentAssistantSessions([...sessions.values()], shownSessions),
    [sessions],
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
    [ordered, pending, shownInputs],
  );
  const latest = ordered[ordered.length - 1];

  return {
    state,
    error,
    lines,
    working: assistantWorking(ordered),
    /** The latest session: queued, it may wait for its offline computer. */
    latestSession: latest,
    /** The latest turn: changes when a message starts a new one. */
    latestTurnId: latest ? `${latest.id}:${latest.input?.id ?? ""}` : "",
    retry: read,
    async send(
      text: string,
      clientId: string,
      runtime: AssistantRuntime,
    ): Promise<void> {
      setPending((current) => [
        ...current.filter((line) => line.clientId !== clientId),
        { clientId, text, at: new Date().toISOString() },
      ]);
      const continued = continuedSession(
        ordered.filter((session) => session.workspaceId === workspaceId),
      );
      try {
        upsert(
          continued
            ? await sendAgentSessionMessage(
                continued.id,
                { prompt: text, inputId: clientId },
                clientId,
              )
            : await createAgentSession(
                {
                  agentId: "",
                  inputId: clientId,
                  prompt: text,
                  source: "chat",
                  workspaceId,
                  ...runtime,
                },
                clientId,
              ),
        );
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
