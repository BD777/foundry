import type {
  AgentBackgroundTask,
  AgentSession,
  AgentSessionEvent,
  AgentScheduledTask,
} from "@bd777/foundry-protocol";
import type { WindowedAgentSession } from "../../api";
import { agentEventKey, eventPosition } from "../../lib/agent-event-log";

/** State events a windowed read sent for this panel, cut to what it reads. */
const panelOnlyEvents = new WeakSet<AgentSessionEvent>();

/** Whether the event is a state event read for the panel alone. */
export function isPanelOnlyEvent(event: AgentSessionEvent): boolean {
  return panelOnlyEvents.has(event);
}

/**
 * The session's events as the panel reads them: the state events a
 * windowed read sent from before the loaded ones (see WindowedAgentSession),
 * each placed by its time, and the loaded events. One loaded since is read
 * from those.
 */
export function withStateEvents(session: AgentSession): AgentSession {
  const state = (session as WindowedAgentSession).stateEvents;
  if (!state?.length) return session;
  const loaded = session.events ?? [];
  const older = state.filter(
    (event) => eventPosition(loaded, agentEventKey(event)) < 0,
  );
  if (older.length === 0) return session;
  older.forEach((event) => panelOnlyEvents.add(event));
  const events: AgentSessionEvent[] = [];
  let next = 0;
  for (const event of loaded) {
    const at = Date.parse(event.at);
    while (next < older.length && !(Date.parse(older[next]!.at) > at)) {
      events.push(older[next++]!);
    }
    events.push(event);
  }
  events.push(...older.slice(next));
  return { ...session, events };
}

/** Latest snapshot wins: it describes the timers still live in the agent. */
export function latestTimerSnapshot(
  session: AgentSession,
): { at: string; tasks: AgentScheduledTask[] } | undefined {
  let snapshot: { at: string; tasks: AgentScheduledTask[] } | undefined;
  for (const event of session.events ?? []) {
    if (event.metadata?.timerSnapshot) {
      snapshot = { at: event.at, tasks: event.metadata.timerSnapshot };
    }
  }
  return snapshot;
}

/** Latest snapshot wins: it describes the session's background work. */
export function latestBackgroundSnapshot(
  session: AgentSession,
): AgentBackgroundTask[] | undefined {
  let snapshot: AgentBackgroundTask[] | undefined;
  for (const event of session.events ?? []) {
    if (event.metadata?.backgroundTaskSnapshot) {
      snapshot = event.metadata.backgroundTaskSnapshot;
    }
  }
  return snapshot;
}
