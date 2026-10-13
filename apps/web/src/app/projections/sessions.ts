import {
  sessionScheduleFromSnapshot,
  type AgentSession,
  type AgentSessionEvent,
} from "@bd777/foundry-protocol";
import type { FoundryData } from "../../api-types";
import { appendAgentEvents } from "../../lib/agent-event-log";
import { isSessionLive } from "../../lib/session-status";
import {
  isMatchingResponseStreamEvent,
  mergeLoadedAgentSession,
} from "../../lib/agent-session-events";
import {
  eachPayload,
  keepStreamed,
  type LoadedMerges,
  type StreamProjection,
  type StreamProjections,
} from "./stream-projection";

/**
 * Sessions a whole streamed session (created, started, ended…) replaced,
 * and sessions that only received transcript events.
 */
export const sessionTouchKinds = ["sessions", "sessionEvents"] as const;

function upsertStreamedAgentSession(
  sessions: AgentSession[],
  incoming: AgentSession,
): AgentSession[] {
  const index = sessions.findIndex((session) => session.id === incoming.id);
  if (index < 0) {
    return [mergeLoadedAgentSession(undefined, incoming), ...sessions];
  }
  const next = [...sessions];
  next[index] = mergeLoadedAgentSession(sessions[index], incoming);
  return next;
}

/** A whole session (without its transcript) of the workspace shown. */
function applySession(data: FoundryData, session: AgentSession): FoundryData {
  if (session.workspaceId !== data.workspace.id) return data;
  return {
    ...data,
    agentSessions: upsertStreamedAgentSession(data.agentSessions, session),
  };
}

/**
 * Adds live events to their sessions: one copy of each session's event list
 * per call, however many of its events arrived.
 */
function applyAgentSessionEvents(
  data: FoundryData,
  events: readonly AgentSessionEvent[],
): FoundryData {
  const bySession = new Map<string, AgentSessionEvent[]>();
  for (const event of events) {
    const list = bySession.get(event.sessionId);
    if (list) list.push(event);
    else bySession.set(event.sessionId, [event]);
  }
  let agentSessions: AgentSession[] | undefined;
  data.agentSessions.forEach((session, index) => {
    const incoming = bySession.get(session.id);
    if (!incoming) return;
    agentSessions ??= [...data.agentSessions];
    // The server keeps the session's schedule from its timer snapshots; a
    // pushed one applies here until the session is read again.
    const snapshot = [...incoming]
      .reverse()
      .find((event) => event.metadata?.timerSnapshot);
    agentSessions[index] = {
      ...session,
      events: appendAgentEvents(session.events, incoming),
      status: session.status === "queued" ? "running" : session.status,
      updatedLabel: isSessionLive(session) ? "running" : session.updatedLabel,
      ...(snapshot
        ? {
            scheduled: sessionScheduleFromSnapshot(
              snapshot.metadata?.timerSnapshot ?? [],
              snapshot.at,
              session.scheduled,
            ),
          }
        : {}),
    };
  });
  return agentSessions ? { ...data, agentSessions } : data;
}

/**
 * Consecutive response snapshots describe the same growing message, so only
 * the newest one in such a run needs to reach React.
 */
function isNewerResponseSnapshot(
  previous: AgentSessionEvent,
  next: AgentSessionEvent,
): boolean {
  return (
    next.label === "Response stream" &&
    previous.label === "Response stream" &&
    previous.sessionId === next.sessionId &&
    isMatchingResponseStreamEvent(previous, next)
  );
}

/** Events carrying the whole session: it replaces the one shown. */
const sessionReplaced: StreamProjection<
  | "agent_session_created"
  | "agent_session_started"
  | "agent_session_blocked"
  | "agent_session_resumed"
  | "agent_session_native_session_id"
  | "agent_session_completed"
> = {
  apply: eachPayload(applySession),
  touches: (session) => [["sessions", session.id]],
};

export const sessionProjections = {
  agent_session_created: sessionReplaced,
  agent_session_started: sessionReplaced,
  agent_session_blocked: sessionReplaced,
  agent_session_resumed: sessionReplaced,
  agent_session_native_session_id: sessionReplaced,
  agent_session_completed: sessionReplaced,
  // One transcript entry: added to its session, which keeps its summary.
  agent_session_event: {
    apply: applyAgentSessionEvents,
    touches: (event) => [["sessionEvents", event.sessionId]],
    supersedes: isNewerResponseSnapshot,
  },
} satisfies StreamProjections;

export const sessionLoadedMerges = {
  // A session an event replaced stays as shown; one that only received
  // transcript events takes the read's summary (keeping its events), but
  // does not go back from running to queued.
  agentSessions: (current, loaded, touched) => {
    const existingSessions = new Map(
      current.agentSessions.map((session) => [session.id, session]),
    );
    const streamedSessions = new Set([
      ...(touched?.sessions ?? []),
      ...(touched?.sessionEvents ?? []),
    ]);
    return keepStreamed(
      current.agentSessions,
      loaded.agentSessions.map((session) => {
        const existing = existingSessions.get(session.id);
        const merged = mergeLoadedAgentSession(existing, session);
        // A live event started it after the read began: still running.
        return touched?.sessionEvents.has(session.id) &&
          existing?.status === "running" &&
          merged.status === "queued"
          ? {
              ...merged,
              status: existing.status,
              updatedLabel: existing.updatedLabel,
            }
          : merged;
      }),
      touched?.sessions,
      streamedSessions,
    );
  },
} satisfies LoadedMerges;
