// The browser event stream (GET /api/events): one connection, shared by
// every subscriber of a tab and, where the browser lets tabs coordinate,
// by every tab of the origin: one tab leads and keeps the connection, the
// others follow what it relays (see tabs.ts). Each tab dispatches events
// by type to its own subscribers and keeps its own lifecycle and epoch.
// What an event means is decided by its subscribers: the workspace-data
// projection (app/projections) and the features that keep their own state.

import { apiBaseUrl } from "../lib/api-base-url";
import type { StreamEventSourceConstructor } from "./event-source-feed";
import {
  createStreamConnection,
  type FoundryStreamEnvironment,
} from "./stream-connection";
import { createStreamStatus } from "./stream-status";
import { createStreamSubscriptions } from "./stream-subscriptions";
import { browserTabs } from "./tabs";

export { foundryStreamReopenDelaysMs } from "./event-source-feed";
export type { FoundryStreamEnvironment } from "./stream-connection";
export { foundryStreamOpenWaitMs } from "./stream-status";
export type {
  AnyStreamEventHandler,
  FoundryStreamLifecycle,
  FoundryStreamResync,
  StreamEventOptions,
} from "./stream-subscriptions";

/** One tab's stream (see the module comment); `foundryStream` is this tab's. */
export function createFoundryStream(environment: FoundryStreamEnvironment) {
  const subscriptions = createStreamSubscriptions({
    isOpen: () => status.isOpen(),
    want: () => connection.want(),
    unwant: () => connection.unwant(),
  });
  const status = createStreamStatus(subscriptions);
  const connection = createStreamConnection(environment, status);

  return {
    isOpen: status.isOpen,

    /**
     * Rises each time events may have been missed: a connection opened with
     * nowhere to resume from (the first one too), or the server said resync.
     * A read that started at the current epoch, after the stream opened,
     * misses nothing: every later change arrives on the stream. One from an
     * earlier epoch may be behind and is read again (see opened).
     */
    epoch: status.epoch,

    /**
     * Resolves when a read of state the stream keeps current may start: at
     * once while the stream is open (the server registered the connection
     * before it answered the opening, so it delivers every change after a
     * later read), else when it opens. A stream not open within
     * foundryStreamOpenWaitMs is waited for no longer, so a slow stream does
     * not keep the page empty; resolves `false` then: the read starts at an
     * epoch the opening ends, and is made again on its resync.
     */
    opened: status.waitOpened,

    /** How long the open stream has delivered nothing (0 when not open). */
    quietMs: (now = Date.now()): number => status.quietMs(now),

    /**
     * Opens the connection again, resuming after the last message: for one
     * that may have died without an error (a sleeping laptop, a stuck
     * proxy). The server's keepalives are comments a page cannot observe.
     * A follower asks its leader.
     */
    reconnect: connection.reconnect,

    onStreamEvent: subscriptions.onStreamEvent,
    onAnyStreamEvent: subscriptions.onAnyStreamEvent,
    onStreamLifecycle: subscriptions.onStreamLifecycle,

    /**
     * The earliest a read's answer may have started and still show all the
     * stream announced to this tab: when the stream last opened with nowhere
     * to resume from, said resync, or announced a change (transcript entries
     * aside). 0 before the stream opened.
     */
    readFloor: status.readFloor,

    /** The other tabs; undefined where tabs cannot coordinate. */
    tabs: connection.joinedTabs,

    /** Tells the other tabs the person signed out. */
    announceSignedOut(): void {
      connection.joinedTabs()?.post({ kind: "signed-out" });
    },

    /** The person signed out in another tab. */
    onSignedOutElsewhere: connection.onSignedOut,
  };
}

export type FoundryStream = ReturnType<typeof createFoundryStream>;

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
