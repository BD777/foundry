import type { AgentSession } from "@foundry/protocol";
import type { FoundryData, FoundryStreamEvent } from "../api-types";
import {
  applyIssueStreamEvent,
  mergeIssue,
  mergeIssueRun,
} from "./issue-data-projection";
import {
  isMatchingResponseStreamEvent,
  mergeAgentSessionEvent,
  mergeLoadedAgentSession,
} from "../lib/agent-session-events";

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

/** Preserve richer streamed session state when a list refresh completes. */
export function mergeLoadedFoundryData(
  current: FoundryData,
  loaded: FoundryData,
): FoundryData {
  if (current === loaded) {
    return current;
  }
  if (current.workspace.id !== loaded.workspace.id) {
    return loaded;
  }
  const existingSessions = new Map(
    current.agentSessions.map((session) => [session.id, session]),
  );
  return {
    ...loaded,
    issues: loaded.issues.map((issue) =>
      mergeIssue(
        current.issues.find((item) => item.id === issue.id),
        issue,
      ),
    ),
    runs: loaded.runs?.map((run) =>
      mergeIssueRun(
        current.runs?.find((item) => item.id === run.id),
        run,
      ),
    ),
    agentSessions: loaded.agentSessions.map((session) =>
      mergeLoadedAgentSession(existingSessions.get(session.id), session),
    ),
  };
}

/**
 * Keep transport bursts cheap without changing the semantic event order.
 * Consecutive response snapshots describe the same growing message, so only
 * the newest snapshot in that run needs to reach React.
 */
export function compactFoundryStreamEvents(
  events: FoundryStreamEvent[],
): FoundryStreamEvent[] {
  const compacted: FoundryStreamEvent[] = [];
  for (const event of events) {
    const previous = compacted[compacted.length - 1];
    if (
      event.type === "agent_session_event" &&
      event.payload.label === "Response stream" &&
      previous?.type === "agent_session_event" &&
      previous.payload.label === "Response stream" &&
      previous.payload.sessionId === event.payload.sessionId &&
      isMatchingResponseStreamEvent(previous.payload, event.payload)
    ) {
      compacted[compacted.length - 1] = event;
    } else {
      compacted.push(event);
    }
  }
  return compacted;
}

/** Apply a daemon stream event to the shared application projection. */
export function applyFoundryStreamEvent(
  current: FoundryData,
  streamEvent: FoundryStreamEvent,
): FoundryData {
  if (streamEvent.type === "evidence_updated") return current;
  if (
    streamEvent.type === "issue_updated" ||
    streamEvent.type === "issue_run_event"
  )
    return applyIssueStreamEvent(current, streamEvent);
  // Feature-owned events: their features subscribe to them directly.
  if (
    streamEvent.type === "feishu_bot_updated" ||
    streamEvent.type === "workspace_members_updated"
  ) {
    return current;
  }
  if (streamEvent.type !== "agent_session_event") {
    if (streamEvent.payload.workspaceId !== current.workspace.id) {
      return current;
    }
    return {
      ...current,
      agentSessions: upsertStreamedAgentSession(
        current.agentSessions,
        streamEvent.payload,
      ),
    };
  }

  const event = streamEvent.payload;
  const index = current.agentSessions.findIndex(
    (session) => session.id === event.sessionId,
  );
  if (index < 0) {
    return current;
  }
  const session = current.agentSessions[index];
  if (!session) {
    return current;
  }
  const nextSession: AgentSession = {
    ...session,
    events: mergeAgentSessionEvent(session.events, event),
    status: session.status === "queued" ? "running" : session.status,
    updatedLabel:
      session.status === "queued" || session.status === "running"
        ? "running"
        : session.updatedLabel,
  };
  const agentSessions = [...current.agentSessions];
  agentSessions[index] = nextSession;
  return { ...current, agentSessions };
}
