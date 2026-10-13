// Who follows a tab's stream: lifecycle subscribers and event handlers by
// type, and the dispatch of each event to them. The first subscriber wants
// the connection; it is let go a moment after the last one leaves.

import {
  isBrowserNoticeType,
  type BrowserEvent,
  type BrowserEventPayloads,
  type BrowserEventType,
} from "@bd777/foundry-protocol";
import type { FoundryStreamEvent } from "../api-types";

export interface FoundryStreamResync {
  /**
   * The first connection this subscriber sees open: state it loaded while
   * that connection was opening may predate it. False: events stopped
   * arriving after they had arrived.
   */
  initial: boolean;
}

export interface FoundryStreamLifecycle {
  /** The stream stopped delivering events; it reconnects by itself. */
  onError?: () => void;
  /**
   * The stream delivers events (again). Told at once when joining an open
   * stream. A reconnect resumes where the last connection stopped (the
   * server replays what was missed), so this is no reason to reload.
   */
  onOpen?: () => void;
  /**
   * Events may be missing: the server could not replay them (it says so
   * with a `resync` message), or a connection opened with nowhere to resume
   * from. State derived from the stream must be loaded again.
   */
  onResync?: (resync: FoundryStreamResync) => void;
}

/** A subscription to events of one type (onStreamEvent). */
export interface StreamEventOptions<
  K extends BrowserEventType,
> extends FoundryStreamLifecycle {
  /** Only events of this workspace, for payloads that name one. */
  workspaceId?: BrowserEventPayloads[K] extends { workspaceId: string }
    ? string
    : never;
}

/** A handler of every event but notices, with when the event arrived. */
export type AnyStreamEventHandler = (
  event: FoundryStreamEvent,
  receivedAt: number,
) => void;

export interface StreamSubscriber {
  lifecycle: FoundryStreamLifecycle;
  /** It was told the stream is open at least once. */
  sawOpen: boolean;
}

/** What subscriptions need of the connection. */
interface SubscribedConnection {
  isOpen(): boolean;
  want(): void;
  unwant(): void;
}

/** A remount re-subscribes at once; the connection is kept this long for it. */
const lastLeaveCloseDelayMs = 1000;

export function createStreamSubscriptions(connection: SubscribedConnection) {
  const subscribers = new Set<StreamSubscriber>();
  /** Handlers of each event type (onStreamEvent). */
  const handlersByType = new Map<
    BrowserEventType,
    Set<(payload: unknown) => void>
  >();
  /** Handlers of every event but notices (onAnyStreamEvent). */
  const anyHandlers = new Set<AnyStreamEventHandler>();
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  function notify(notifyOne: (subscriber: StreamSubscriber) => void): void {
    for (const subscriber of [...subscribers]) {
      if (subscribers.has(subscriber)) isolated(() => notifyOne(subscriber));
    }
  }

  /**
   * Hands an event to the handlers of every one (the workspace-data
   * projection and its ledger), then to those of its type. A handler that
   * throws keeps the event from no other.
   */
  function dispatch(event: BrowserEvent, at: number): void {
    if (!isBrowserNoticeType(event.type))
      for (const handler of [...anyHandlers])
        isolated(() => handler(event as FoundryStreamEvent, at));
    for (const handler of [...(handlersByType.get(event.type) ?? [])])
      isolated(() => handler(event.payload));
  }

  /** Registers a subscriber, opening the connection; returns its leave. */
  function join(lifecycle: FoundryStreamLifecycle): () => void {
    const open = connection.isOpen();
    const subscriber: StreamSubscriber = { lifecycle, sawOpen: open };
    subscribers.add(subscriber);
    if (closeTimer !== undefined) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
    if (open && lifecycle.onOpen) {
      // Joined an open stream: the subscriber loads its own state after this,
      // so it only needs to know the stream is up.
      const onOpen = lifecycle.onOpen;
      queueMicrotask(() => {
        if (subscribers.has(subscriber)) onOpen();
      });
    }
    connection.want();
    return once(() => {
      subscribers.delete(subscriber);
      if (subscribers.size > 0) return;
      closeTimer = setTimeout(() => {
        closeTimer = undefined;
        if (subscribers.size === 0) connection.unwant();
      }, lastLeaveCloseDelayMs);
    });
  }

  return {
    notify,
    dispatch,

    /**
     * Follows the events of one type: `handler` receives each one's payload
     * (of `options.workspaceId` only, when given), with the stream's
     * lifecycle. The only way to receive notices (browserNoticeTypes).
     */
    onStreamEvent<K extends BrowserEventType>(
      type: K,
      handler: (payload: BrowserEventPayloads[K]) => void,
      options: StreamEventOptions<K> = {},
    ): () => void {
      const { workspaceId, ...lifecycle } = options;
      const handlers = handlersByType.get(type) ?? new Set();
      handlersByType.set(type, handlers);
      const receive = (payload: unknown) => {
        if (
          workspaceId === undefined ||
          (payload as { workspaceId?: string }).workspaceId === workspaceId
        )
          handler(payload as BrowserEventPayloads[K]);
      };
      handlers.add(receive);
      const leave = join(lifecycle);
      return once(() => {
        handlers.delete(receive);
        // Only this subscription's set: a later one may have replaced it.
        if (handlers.size === 0 && handlersByType.get(type) === handlers)
          handlersByType.delete(type);
        leave();
      });
    },

    /**
     * Follows every event but notices, in the order they arrive, with when
     * they arrived (the leader's clock: the same for every tab): for the
     * workspace-data projection, which batches and orders them itself.
     */
    onAnyStreamEvent(
      handler: AnyStreamEventHandler,
      lifecycle: FoundryStreamLifecycle = {},
    ): () => void {
      const receive: AnyStreamEventHandler = (event, at) => handler(event, at);
      anyHandlers.add(receive);
      const leave = join(lifecycle);
      return once(() => {
        anyHandlers.delete(receive);
        leave();
      });
    },

    /** Keeps the stream open for its lifecycle alone. */
    onStreamLifecycle: (lifecycle: FoundryStreamLifecycle): (() => void) =>
      join(lifecycle),
  };
}

export type StreamSubscriptions = ReturnType<typeof createStreamSubscriptions>;

/** Runs a subscriber's code; what it throws is reported, not passed on. */
function isolated(run: () => void): void {
  try {
    run();
  } catch (error) {
    console.error("A stream subscriber failed", error);
  }
}

/** `leave`, which does its work the first time only. */
function once(leave: () => void): () => void {
  let left = false;
  return () => {
    if (left) return;
    left = true;
    leave();
  };
}
