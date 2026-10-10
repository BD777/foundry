import type { FoundryStreamEvent } from "../api-types";

/** What live events changed after a point: their entity ids by kind. */
export interface StreamTouches {
  devices: ReadonlySet<string>;
  issues: ReadonlySet<string>;
  /** Sessions a whole streamed session (created, started, ended…) replaced. */
  sessions: ReadonlySet<string>;
  /** Sessions that only received transcript events. */
  sessionEvents: ReadonlySet<string>;
  /** Chats of the chat list the stream sent or removed. */
  chats: ReadonlySet<string>;
}

type TouchKind = keyof StreamTouches;

/** The entities a live event changes in the workspace data. */
function touchedEntities(event: FoundryStreamEvent): [TouchKind, string][] {
  switch (event.type) {
    case "device_status_changed":
      return [["devices", event.payload.deviceId]];
    case "issue_created":
    case "issue_updated":
      return [["issues", event.payload.id]];
    case "agent_session_event":
      return [["sessionEvents", event.payload.sessionId]];
    case "agent_session_created":
    case "agent_session_started":
    case "agent_session_blocked":
    case "agent_session_resumed":
    case "agent_session_completed":
    case "agent_session_native_session_id":
      return [["sessions", event.payload.id]];
    case "chats_changed":
      return [
        ...event.payload.chats.map((chat): [TouchKind, string] => [
          "chats",
          chat.id,
        ]),
        ...event.payload.removed.map((id): [TouchKind, string] => [
          "chats",
          id,
        ]),
      ];
    default:
      // Run events only add to a run; merging keeps what either side has.
      return [];
  }
}

/** How many recent events the ledger keeps for eventsSince. */
export const ledgerEventCapacity = 512;

/**
 * Orders workspace-data reads against live events. A read notes `mark()`
 * when it starts; when it lands, whatever live events changed after that
 * mark is at least as new as the read (the stream delivers in order, and
 * replays or says resync after a gap), so the read must not overwrite it.
 * It also keeps the latest events, for a read of another workspace, which
 * the events shown so far did not apply to.
 */
export function createStreamTouchLedger() {
  let count = 0;
  const touched = new Map<string, number>();
  const recent: { time: number; event: FoundryStreamEvent }[] = [];
  /** When the newest event the ledger let go of arrived. */
  let droppedAt = -Infinity;
  const key = (kind: TouchKind, id: string) => `${kind}\n${id}`;
  return {
    mark(): number {
      return count;
    },
    record(event: FoundryStreamEvent): void {
      count += 1;
      recent.push({ time: Date.now(), event });
      if (recent.length > ledgerEventCapacity) droppedAt = recent.shift()!.time;
      for (const [kind, id] of touchedEntities(event)) {
        if (id) touched.set(key(kind, id), count);
      }
    },
    since(mark: number): StreamTouches {
      const result: Record<TouchKind, Set<string>> = {
        devices: new Set(),
        issues: new Set(),
        sessions: new Set(),
        sessionEvents: new Set(),
        chats: new Set(),
      };
      if (mark >= count) return result;
      for (const [entry, at] of touched) {
        if (at <= mark) continue;
        const [kind, id] = entry.split("\n") as [TouchKind, string];
        result[kind].add(id);
      }
      return result;
    },
    /**
     * The events that arrived at `time` or later, in order; undefined when
     * the ledger no longer holds them all.
     */
    eventsSince(time: number): FoundryStreamEvent[] | undefined {
      if (droppedAt >= time) return undefined;
      return recent
        .filter((entry) => entry.time >= time)
        .map((entry) => entry.event);
    },
  };
}

export type StreamTouchLedger = ReturnType<typeof createStreamTouchLedger>;
