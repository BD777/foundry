// Keeping a tab's connection: alone, or as the tabs' leader, relaying what
// it reports; a follower takes its leader's relays as its own stream.

import {
  openStreamFeed,
  type StreamEventSourceConstructor,
  type StreamFeed,
} from "./event-source-feed";
import type { StreamStatus } from "./stream-status";
import {
  joinTabs,
  type ReceivedTabMessage,
  type Tabs,
  type TabsEnvironment,
} from "./tabs";

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

export function createStreamConnection(
  environment: FoundryStreamEnvironment,
  status: StreamStatus,
) {
  /** The connection, while this tab keeps it (alone or leading). */
  let feed: StreamFeed | undefined;
  /** The other tabs, once this one joined them. */
  let tabs: Tabs | undefined;
  let tabsChecked = false;
  /** Ends this tab's wish to lead (or its leadership). */
  let leaveLeadership: (() => void) | undefined;
  let wanted = false;
  /** When this tab last opened its connection, or asked it to reopen. */
  let connectedAt = 0;
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

  /** Opens this tab's connection; a leader relays what it reports. */
  function keepConnection(): void {
    if (feed) return;
    feed = openStreamFeed(
      environment.url,
      environment.eventSource(),
      status.lastEventId,
      {
        opened() {
          const at = Date.now();
          const lastEventId = status.lastEventId();
          const fresh = lastEventId === "";
          connectedAt = at;
          if (tabs?.leading())
            tabs.post({ kind: "open", fresh, lastEventId, at });
          status.opened(fresh, at);
        },
        failed() {
          if (tabs?.leading()) tabs.post({ kind: "error" });
          status.failed();
        },
        received(id, data) {
          const at = Date.now();
          if (tabs?.leading()) tabs.post({ kind: "event", id, data, at });
          status.message(id, data, at);
        },
      },
    );
  }

  /** This tab leads now: it keeps the connection, resuming where it was. */
  function lead(): void {
    tabs!.post({ kind: "leader" });
    // Relays of the tab that led stop here; this connection resumes after
    // the last of them.
    if (status.isOpen()) status.failed();
    keepConnection();
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
            open: status.isOpen(),
            lastEventId: status.lastEventId(),
          });
        return;
      case "reconnect":
        if (leading && Date.now() - connectedAt >= reconnectRequestGraceMs)
          reconnect();
        return;
      case "signed-out":
        signedOutListeners.forEach((listener) => listener());
        return;
      case "leader":
      case "resign":
        // The stream stops until the next leader's connection opens.
        if (fromLeader && wanted && status.isOpen()) status.failed();
        return;
    }
    if (leading || !wanted || !fromLeader) return;
    switch (message.kind) {
      case "state":
        if (!message.open || status.isOpen()) return;
        status.adoptLastEventId(message.lastEventId);
        status.opened(false, Date.now());
        return;
      case "open":
        status.adoptLastEventId(message.lastEventId);
        status.opened(message.fresh, message.at);
        return;
      case "error":
        if (status.isOpen()) status.failed();
        return;
      case "event":
        status.message(message.id, message.data, message.at);
        return;
    }
  }

  function reconnect(): void {
    if (!wanted) return;
    if (!feed) {
      // The leader keeps the connection.
      tabs?.post({ kind: "reconnect" });
      return;
    }
    status.pause();
    connectedAt = Date.now();
    feed.reconnect();
  }

  return {
    joinedTabs,
    reconnect,

    want(): void {
      if (wanted) return;
      wanted = true;
      const joined = joinedTabs();
      if (!joined) {
        keepConnection();
        return;
      }
      leaveLeadership = joined.seekLeadership(lead);
      // A leader, if any, says how its connection is.
      joined.post({ kind: "hello" });
    },

    unwant(): void {
      wanted = false;
      feed?.close();
      feed = undefined;
      if (tabs?.leading()) tabs.post({ kind: "resign" });
      leaveLeadership?.();
      leaveLeadership = undefined;
      status.reset();
    },

    onSignedOut(listener: () => void): () => void {
      joinedTabs();
      signedOutListeners.add(listener);
      return () => signedOutListeners.delete(listener);
    },
  };
}
