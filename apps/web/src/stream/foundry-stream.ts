// The browser event stream (GET /api/events): one connection, shared by
// every subscriber of a tab and, where the browser lets tabs coordinate,
// by every tab of the origin: one tab leads and keeps the connection, the
// others follow what it relays (see tabs.ts). Each tab dispatches events
// by type to its own subscribers and keeps its own lifecycle and epoch.
// What an event means is decided by its subscribers: the workspace-data
// projection (app/projections) and the features that keep their own state.

import {
  browserStreamControlTypes,
  isBrowserEventType,
  isBrowserNoticeType,
  parseProtocolEnvelopeJSON,
  type BrowserEvent,
  type BrowserEventPayloads,
  type BrowserEventType,
} from "@bd777/foundry-protocol";
import type { FoundryStreamEvent } from "../api-types";
import { apiBaseUrl } from "../lib/api-base-url";
import {
  openStreamFeed,
  type StreamEventSourceConstructor,
  type StreamFeed,
} from "./event-source-feed";
import {
  browserTabs,
  joinTabs,
  type ReceivedTabMessage,
  type Tabs,
  type TabsEnvironment,
} from "./tabs";

export { foundryStreamReopenDelaysMs } from "./event-source-feed";

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

/** How long a read waits for the stream to open (foundryStreamOpened). */
export const foundryStreamOpenWaitMs = 1_500;

/**
 * A follower's request to reconnect is not repeated by the leader within
 * this long of (re)opening: every tab's watchdog and `online` handler asks.
 */
const reconnectRequestGraceMs = 5_000;

/** What a tab's stream needs of the browser. */
export interface FoundryStreamEnvironment {
  /** GET /api/events. */
  url: string;
  eventSource: () => StreamEventSourceConstructor;
  /** The other tabs of the origin; undefined: this tab streams alone. */
  tabs: () => TabsEnvironment | undefined;
}

interface Subscriber {
  lifecycle: FoundryStreamLifecycle;
  /** It was told the stream is open at least once. */
  sawOpen: boolean;
}

/** A handler of every event but notices, with when the event arrived. */
export type AnyStreamEventHandler = (
  event: FoundryStreamEvent,
  receivedAt: number,
) => void;

/** One tab's stream (see the module comment); `foundryStream` is this tab's. */
export function createFoundryStream(environment: FoundryStreamEnvironment) {
  const subscribers = new Set<Subscriber>();
  /** Handlers of each event type (onStreamEvent). */
  const handlersByType = new Map<
    BrowserEventType,
    Set<(payload: unknown) => void>
  >();
  /** Handlers of every event but notices (onAnyStreamEvent). */
  const anyHandlers = new Set<AnyStreamEventHandler>();
  /** Reads waiting for the stream to open (see opened). */
  const openWaiters = new Set<() => void>();
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
    /** When this tab last opened its connection, or asked it to reopen. */
    connectedAt: 0,
    wanted: false,
    closeTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  };
  /** The connection, while this tab keeps it (alone or leading). */
  let feed: StreamFeed | undefined;
  /** The other tabs, once this one joined them. */
  let tabs: Tabs | undefined;
  let tabsChecked = false;
  /** Ends this tab's wish to lead (or its leadership). */
  let leaveLeadership: (() => void) | undefined;
  const signedOutListeners = new Set<() => void>();

  /** The other tabs, joined on first need; undefined without the APIs. */
  function joinedTabs(): Tabs | undefined {
    if (tabsChecked) return tabs;
    tabsChecked = true;
    const available = environment.tabs();
    if (!available) return undefined;
    tabs = joinTabs(available);
    tabs.listen(receiveFromTab);
    return tabs;
  }

  // -- What the connection reports, from this tab's feed or the leader's.

  function streamOpened(fresh: boolean, at: number): void {
    state.open = true;
    state.heardAt = Date.now();
    // Only without a place to resume from can events have been lost.
    fresh ||= !state.everOpen;
    state.everOpen = true;
    if (fresh) {
      state.epoch += 1;
      state.changedAt = Math.max(state.changedAt, at);
    }
    notifySubscribers((subscriber) => {
      const initial = !subscriber.sawOpen;
      subscriber.sawOpen = true;
      subscriber.lifecycle.onOpen?.();
      if (fresh) subscriber.lifecycle.onResync?.({ initial });
    });
    const waiters = [...openWaiters];
    openWaiters.clear();
    waiters.forEach((opened) => opened());
  }

  function streamFailed(): void {
    state.open = false;
    notifySubscribers((subscriber) => subscriber.lifecycle.onError?.());
  }

  function streamMessage(id: string, data: string, at: number): void {
    state.heardAt = Date.now();
    let event: BrowserEvent;
    try {
      const envelope = parseProtocolEnvelopeJSON(data);
      if (envelope.type === browserStreamControlTypes.resync) {
        state.lastEventId = newerEventId(state.lastEventId, id);
        state.changedAt = Math.max(state.changedAt, at);
        resync();
        return;
      }
      // A leader that took over resumes from where it was: a tab that was
      // ahead of it has seen the first of what it relays.
      if (!isNewEventId(state.lastEventId, id)) return;
      state.lastEventId = newerEventId(state.lastEventId, id);
      // Others (stream_ready, names this client does not know) carry nothing
      // to apply.
      if (!isBrowserEventType(envelope.type)) return;
      event = envelope as BrowserEvent;
    } catch {
      // A later persisted snapshot repairs malformed or interrupted stream data.
      state.lastEventId = newerEventId(state.lastEventId, id);
      return;
    }
    if (!event.payload) return;
    // A transcript entry changes no read but the transcript's, which
    // merges what it reads with what streamed (see readFloor).
    if (event.type !== "agent_session_event")
      state.changedAt = Math.max(state.changedAt, at);
    dispatch(event, at);
  }

  /** Events may have been missed: everyone loads what it derived again. */
  function resync(): void {
    state.epoch += 1;
    notifySubscribers((subscriber) =>
      subscriber.lifecycle.onResync?.({ initial: false }),
    );
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

  function notifySubscribers(notify: (subscriber: Subscriber) => void): void {
    for (const subscriber of [...subscribers]) {
      if (subscribers.has(subscriber)) isolated(() => notify(subscriber));
    }
  }

  // -- Keeping the connection: alone, or as the tabs' leader.

  /** Opens this tab's connection; a leader relays what it reports. */
  function keepConnection(): void {
    if (feed) return;
    feed = openStreamFeed(
      environment.url,
      environment.eventSource(),
      () => state.lastEventId,
      {
        opened() {
          const at = Date.now();
          const fresh = state.lastEventId === "";
          state.connectedAt = at;
          if (tabs?.leading())
            tabs.post({
              kind: "open",
              fresh,
              lastEventId: state.lastEventId,
              at,
            });
          streamOpened(fresh, at);
        },
        failed() {
          if (tabs?.leading()) tabs.post({ kind: "error" });
          streamFailed();
        },
        received(id, data) {
          const at = Date.now();
          if (tabs?.leading()) tabs.post({ kind: "event", id, data, at });
          streamMessage(id, data, at);
        },
      },
    );
  }

  function want(): void {
    if (state.wanted) return;
    state.wanted = true;
    const joined = joinedTabs();
    if (!joined) {
      keepConnection();
      return;
    }
    leaveLeadership = joined.seekLeadership(lead);
    // A leader, if any, says how its connection is.
    joined.post({ kind: "hello" });
  }

  /** This tab leads now: it keeps the connection, resuming where it was. */
  function lead(): void {
    tabs!.post({ kind: "leader" });
    // Relays of the tab that led stop here; this connection resumes after
    // the last of them.
    if (state.open) streamFailed();
    keepConnection();
  }

  function unwant(): void {
    state.wanted = false;
    feed?.close();
    feed = undefined;
    if (tabs?.leading()) tabs.post({ kind: "resign" });
    leaveLeadership?.();
    leaveLeadership = undefined;
    state.open = false;
    state.everOpen = false;
    // Whoever subscribes next loads its own state; nothing to resume.
    state.lastEventId = "";
  }

  /** What other tabs say: a follower takes its leader's stream as its own. */
  function receiveFromTab(
    message: ReceivedTabMessage,
    fromLeader: boolean,
  ): void {
    const leading = tabs!.leading();
    switch (message.kind) {
      case "hello":
        if (leading)
          tabs!.post({
            kind: "state",
            open: state.open,
            lastEventId: state.lastEventId,
          });
        return;
      case "reconnect":
        if (
          leading &&
          Date.now() - state.connectedAt >= reconnectRequestGraceMs
        )
          reconnect();
        return;
      case "signed-out":
        signedOutListeners.forEach((listener) => listener());
        return;
      case "leader":
      case "resign":
        // The stream stops until the next leader's connection opens.
        if (fromLeader && state.wanted && state.open) streamFailed();
        return;
    }
    if (leading || !state.wanted || !fromLeader) return;
    switch (message.kind) {
      case "state":
        if (!message.open || state.open) return;
        state.lastEventId = newerEventId(
          state.lastEventId,
          message.lastEventId,
        );
        streamOpened(false, Date.now());
        return;
      case "open":
        state.lastEventId = newerEventId(
          state.lastEventId,
          message.lastEventId,
        );
        streamOpened(message.fresh, message.at);
        return;
      case "error":
        if (state.open) streamFailed();
        return;
      case "event":
        streamMessage(message.id, message.data, message.at);
        return;
    }
  }

  function reconnect(): void {
    if (!state.wanted) return;
    if (!feed) {
      // The leader keeps the connection.
      tabs?.post({ kind: "reconnect" });
      return;
    }
    state.open = false;
    state.connectedAt = Date.now();
    feed.reconnect();
  }

  /** Registers a subscriber, opening the connection; returns its leave. */
  function join(lifecycle: FoundryStreamLifecycle): () => void {
    const subscriber: Subscriber = { lifecycle, sawOpen: state.open };
    subscribers.add(subscriber);
    if (state.closeTimer !== undefined) {
      clearTimeout(state.closeTimer);
      state.closeTimer = undefined;
    }
    if (state.open && lifecycle.onOpen) {
      // Joined an open stream: the subscriber loads its own state after this,
      // so it only needs to know the stream is up.
      const onOpen = lifecycle.onOpen;
      queueMicrotask(() => {
        if (subscribers.has(subscriber)) onOpen();
      });
    }
    want();
    return once(() => {
      subscribers.delete(subscriber);
      if (subscribers.size > 0) return;
      // A remount re-subscribes at once; keep the connection for it.
      state.closeTimer = setTimeout(() => {
        state.closeTimer = undefined;
        if (subscribers.size === 0) unwant();
      }, 1000);
    });
  }

  return {
    isOpen: (): boolean => state.open,

    /**
     * Rises each time events may have been missed: a connection opened with
     * nowhere to resume from (the first one too), or the server said resync.
     * A read that started at the current epoch, after the stream opened,
     * misses nothing: every later change arrives on the stream. One from an
     * earlier epoch may be behind and is read again (see opened).
     */
    epoch: (): number => state.epoch,

    /**
     * Resolves when a read of state the stream keeps current may start: at
     * once while the stream is open (the server registered the connection
     * before it answered the opening, so it delivers every change after a
     * later read), else when it opens. A stream not open within
     * foundryStreamOpenWaitMs is waited for no longer, so a slow stream does
     * not keep the page empty; resolves `false` then: the read starts at an
     * epoch the opening ends, and is made again on its resync.
     */
    opened(): Promise<boolean> {
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

    /** How long the open stream has delivered nothing (0 when not open). */
    quietMs: (now = Date.now()): number =>
      state.open ? Math.max(0, now - state.heardAt) : 0,

    /**
     * Opens the connection again, resuming after the last message: for one
     * that may have died without an error (a sleeping laptop, a stuck
     * proxy). The server's keepalives are comments a page cannot observe.
     * A follower asks its leader.
     */
    reconnect,

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

    /**
     * The earliest a read's answer may have started and still show all the
     * stream announced to this tab: when the stream last opened with nowhere
     * to resume from, said resync, or announced a change (transcript entries
     * aside). 0 before the stream opened.
     */
    readFloor: (): number => state.changedAt,

    /** The other tabs; undefined where tabs cannot coordinate. */
    tabs: joinedTabs,

    /** Tells the other tabs the person signed out. */
    announceSignedOut(): void {
      joinedTabs()?.post({ kind: "signed-out" });
    },

    /** The person signed out in another tab. */
    onSignedOutElsewhere(listener: () => void): () => void {
      joinedTabs();
      signedOutListeners.add(listener);
      return () => signedOutListeners.delete(listener);
    },
  };
}

export type FoundryStream = ReturnType<typeof createFoundryStream>;

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

/** A stream message id: `<epoch>-<seq>` (the server's process and order). */
function parseEventId(id: string): { epoch: string; seq: number } | undefined {
  const at = id.lastIndexOf("-");
  if (at <= 0) return undefined;
  const seq = Number(id.slice(at + 1));
  return Number.isSafeInteger(seq)
    ? { epoch: id.slice(0, at), seq }
    : undefined;
}

/**
 * Whether `id` comes after `last`: a later message of the same server
 * process, or one of another (it restarted, and says resync). Ids it
 * cannot order are new.
 */
function isNewEventId(last: string, id: string): boolean {
  const before = parseEventId(last);
  const next = parseEventId(id);
  if (!before || !next || before.epoch !== next.epoch) return true;
  return next.seq > before.seq;
}

function newerEventId(last: string, id: string): string {
  if (!id) return last;
  return isNewEventId(last, id) ? id : last;
}

/** This tab's stream. */
export const foundryStream = createFoundryStream({
  url: `${apiBaseUrl}/api/events`,
  eventSource: () =>
    globalThis.EventSource as unknown as StreamEventSourceConstructor,
  tabs: browserTabs,
});

export const isFoundryStreamOpen = foundryStream.isOpen;
export const foundryStreamEpoch = foundryStream.epoch;
export const foundryStreamOpened = foundryStream.opened;
export const foundryStreamQuietMs = foundryStream.quietMs;
export const reconnectFoundryStream = foundryStream.reconnect;
export const onStreamEvent = foundryStream.onStreamEvent;
export const onAnyStreamEvent = foundryStream.onAnyStreamEvent;
export const onStreamLifecycle = foundryStream.onStreamLifecycle;
