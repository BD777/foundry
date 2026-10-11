import type { FoundryStreamEvent } from "../api-types";
import {
  streamEventTouches,
  touchKinds,
  type StreamTouches,
  type TouchKind,
} from "./projections";

/** How many recent events the ledger keeps for eventsSince. */
export const ledgerEventCapacity = 512;

/**
 * Orders workspace-data reads against live events. A read notes `mark()`
 * when it starts, or `markAt(requestedAt)` when it lands (an answer may have
 * started in another tab); whatever live events changed after that mark is
 * at least as new as the read (the stream delivers in order, and replays or
 * says resync after a gap), so the read must not overwrite it. It also
 * keeps the latest events, for a read of another workspace, which the
 * events shown so far did not apply to. Events are recorded at the time the
 * stream received them (the same clock in every tab).
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
    /**
     * The mark a read that started at `time` took: events received then or
     * later come after it. 0 when the ledger no longer holds them all.
     */
    markAt(time: number): number {
      if (droppedAt >= time) return 0;
      let later = 0;
      for (let index = recent.length - 1; index >= 0; index--) {
        if (recent[index]!.time < time) break;
        later += 1;
      }
      return count - later;
    },
    record(event: FoundryStreamEvent, receivedAt = Date.now()): void {
      count += 1;
      recent.push({ time: receivedAt, event });
      if (recent.length > ledgerEventCapacity) droppedAt = recent.shift()!.time;
      for (const [kind, id] of streamEventTouches(event)) {
        if (id) touched.set(key(kind, id), count);
      }
    },
    since(mark: number): StreamTouches {
      const result = Object.fromEntries(
        touchKinds.map((kind) => [kind, new Set<string>()]),
      ) as Record<TouchKind, Set<string>>;
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
