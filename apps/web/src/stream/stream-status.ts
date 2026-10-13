// What a tab's stream has delivered: whether it is open, where it resumes,
// its epoch and read floor. It takes what the connection reports, from this
// tab's feed or the leader's relays, and tells the subscribers.

import { decodeStreamFrame, isNewEventId, newerEventId } from "./stream-frames";
import type { StreamSubscriptions } from "./stream-subscriptions";

/** How long a read waits for the stream to open (foundryStreamOpened). */
export const foundryStreamOpenWaitMs = 1_500;

type StatusSubscribers = Pick<StreamSubscriptions, "notify" | "dispatch">;

export function createStreamStatus(subscribers: StatusSubscribers) {
  const state = {
    open: false,
    /** The stream was open since subscribers wanted it. */
    everOpen: false,
    /** The newest message id seen: where a connection resumes. */
    lastEventId: "",
    /** When the stream last opened or delivered a message. */
    heardAt: 0,
    /** Rises whenever events may have been missed (see epoch). */
    epoch: 0,
    /**
     * When the stream last changed something reads return (see readFloor):
     * it opened with nowhere to resume from, said resync, or delivered an
     * event other than a transcript entry.
     */
    changedAt: 0,
  };
  /** Reads waiting for the stream to open (see opened). */
  const openWaiters = new Set<() => void>();

  /** Events may have been missed: everyone loads what it derived again. */
  function resync(): void {
    state.epoch += 1;
    subscribers.notify((subscriber) =>
      subscriber.lifecycle.onResync?.({ initial: false }),
    );
  }

  return {
    isOpen: (): boolean => state.open,
    lastEventId: (): string => state.lastEventId,
    epoch: (): number => state.epoch,
    readFloor: (): number => state.changedAt,
    quietMs: (now: number): number =>
      state.open ? Math.max(0, now - state.heardAt) : 0,

    /** Resumes no earlier than `id` (a leader's place). */
    adoptLastEventId(id: string): void {
      state.lastEventId = newerEventId(state.lastEventId, id);
    },

    /** Closed on purpose to reopen at once: subscribers are not told. */
    pause(): void {
      state.open = false;
    },

    /** Nobody wants the stream: whoever subscribes next loads its own state. */
    reset(): void {
      state.open = false;
      state.everOpen = false;
      state.lastEventId = "";
    },

    opened(fresh: boolean, at: number): void {
      state.open = true;
      state.heardAt = Date.now();
      // Only without a place to resume from can events have been lost.
      fresh ||= !state.everOpen;
      state.everOpen = true;
      if (fresh) {
        state.epoch += 1;
        state.changedAt = Math.max(state.changedAt, at);
      }
      subscribers.notify((subscriber) => {
        const initial = !subscriber.sawOpen;
        subscriber.sawOpen = true;
        subscriber.lifecycle.onOpen?.();
        if (fresh) subscriber.lifecycle.onResync?.({ initial });
      });
      const waiters = [...openWaiters];
      openWaiters.clear();
      waiters.forEach((opened) => opened());
    },

    failed(): void {
      state.open = false;
      subscribers.notify((subscriber) => subscriber.lifecycle.onError?.());
    },

    message(id: string, data: string, at: number): void {
      state.heardAt = Date.now();
      // A leader that took over resumes from where it was: a tab that was
      // ahead of it has seen the first of what it relays.
      const unseen = isNewEventId(state.lastEventId, id);
      state.lastEventId = newerEventId(state.lastEventId, id);
      const frame = decodeStreamFrame(data);
      if (frame?.kind === "resync") {
        state.changedAt = Math.max(state.changedAt, at);
        resync();
        return;
      }
      if (!unseen || !frame) return;
      // A transcript entry changes no read but the transcript's, which
      // merges what it reads with what streamed (see readFloor).
      if (frame.event.type !== "agent_session_event")
        state.changedAt = Math.max(state.changedAt, at);
      subscribers.dispatch(frame.event, at);
    },

    /** See FoundryStream.opened. */
    waitOpened(): Promise<boolean> {
      if (state.open) return Promise.resolve(true);
      return new Promise((resolve) => {
        const opened = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          openWaiters.delete(opened);
          resolve(false);
        }, foundryStreamOpenWaitMs);
        openWaiters.add(opened);
      });
    },
  };
}

export type StreamStatus = ReturnType<typeof createStreamStatus>;
