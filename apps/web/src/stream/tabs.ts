// The tabs of one origin share one event stream and one read cache. They
// talk over a BroadcastChannel and elect the tab that keeps the stream's
// connection with a Web Lock: the browser grants it to one tab at a time
// and hands it to the next waiting tab when its holder resigns, closes or
// crashes. Without either API every tab keeps its own connection.

/** A message of one tab to the others (see TabMessage). */
export type TabMessage =
  /** A tab started following the stream: the leader says how it is. */
  | { kind: "hello" }
  /** This tab leads from now on. */
  | { kind: "leader" }
  /** This tab stops leading. */
  | { kind: "resign" }
  /** The leader's answer to hello: its connection, and where it is. */
  | { kind: "state"; open: boolean; lastEventId: string }
  /**
   * The leader's connection opened. `fresh`: it had nowhere to resume
   * from, so events may be missing.
   */
  | { kind: "open"; fresh: boolean; lastEventId: string; at: number }
  /** The leader's connection stopped delivering; it reconnects by itself. */
  | { kind: "error" }
  /** A message of the stream, as the leader received it at `at`. */
  | { kind: "event"; id: string; data: string; at: number }
  /** A follower asks the leader to open the connection again. */
  | { kind: "reconnect" }
  /** The person signed out in that tab. */
  | { kind: "signed-out" }
  /** A follower asks the leader for a read (see shared-reads.ts). */
  | { kind: "read"; key: string; since: number; request: string }
  /** A read's answer, for every tab that asked for it or will. */
  | { kind: "answer"; key: string; answer: SharedAnswer; requests: string[] }
  /** A read that got no answer (the network failed, it timed out). */
  | { kind: "read-failed"; key: string; requests: string[]; message: string };

/** A read's answer as tabs share it (see shared-reads.ts). */
export interface SharedAnswer {
  status: number;
  etag: string;
  body: string;
  /** When the read was sent (Date.now() of the tab that sent it). */
  requestedAt: number;
}

/** A message from another tab, with who sent it. */
export type ReceivedTabMessage = TabMessage & { from: string };

/** BroadcastChannel as tabs use it. */
export interface TabChannel {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** The Web Locks API as the election uses it. */
export interface TabLocks {
  request(
    name: string,
    options: { signal?: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<unknown>;
}

/** What tabs need of the browser to coordinate. */
export interface TabsEnvironment {
  locks: TabLocks;
  openChannel: (name: string) => TabChannel;
}

const channelName = "foundry-tabs";
const leaderLockName = "foundry-stream-leader";

/** The browser's tab APIs; undefined where it lacks one of them. */
export function browserTabs(): TabsEnvironment | undefined {
  const locks = (globalThis.navigator as { locks?: TabLocks } | undefined)
    ?.locks;
  const Channel = globalThis.BroadcastChannel;
  if (!locks || typeof Channel !== "function") return undefined;
  return {
    locks,
    openChannel: (name) => new Channel(name) as unknown as TabChannel,
  };
}

export type TabListener = (
  message: ReceivedTabMessage,
  fromLeader: boolean,
) => void;

/** This tab among the others of its origin. */
export interface Tabs {
  /** This tab leads: its connection serves every tab. */
  leading(): boolean;
  /** Another tab leads (this one heard from it): it can be asked. */
  leaderElsewhere(): boolean;
  post(message: TabMessage): void;
  /**
   * Receives the other tabs' messages, and whether each comes from the tab
   * that leads (that led, for a resign); returns the unsubscribe.
   */
  listen(receive: TabListener): () => void;
  /**
   * Waits to lead (the browser grants one tab at a time); `granted` runs
   * once this tab leads. Returns what withdraws the wish, or resigns once
   * leading.
   */
  seekLeadership(granted: () => void): () => void;
  /** Runs whenever this tab starts leading; returns the unsubscribe. */
  onLeading(listener: () => void): () => void;
}

/** Joins the tabs of this origin. */
export function joinTabs(environment: TabsEnvironment): Tabs {
  const id = randomTabId();
  const channel = environment.openChannel(channelName);
  const listeners = new Set<TabListener>();
  const leadingListeners = new Set<() => void>();
  let leading = false;
  /** The tab that leads, as far as this one heard. */
  let leaderId: string | undefined;

  channel.onmessage = ({ data }) => {
    const message = data as ReceivedTabMessage;
    if (!message || typeof message !== "object" || message.from === id) return;
    const fromLeader = noteLeader(message);
    for (const listener of [...listeners]) listener(message, fromLeader);
  };

  /** Follows who leads; says whether `message` comes from that tab. */
  function noteLeader(message: ReceivedTabMessage): boolean {
    if (leading) return false;
    switch (message.kind) {
      case "leader":
      case "state":
        leaderId = message.from;
        return true;
      case "resign":
        if (message.from !== leaderId) return false;
        leaderId = undefined;
        return true;
      case "open":
      case "error":
      case "event":
        // Joined while a leader relays: it is that one.
        leaderId ??= message.from;
        return message.from === leaderId;
      default:
        return message.from === leaderId;
    }
  }

  return {
    leading: () => leading,
    leaderElsewhere: () => !leading && leaderId !== undefined,
    post(message) {
      channel.postMessage({ ...message, from: id });
    },
    listen(receive) {
      listeners.add(receive);
      return () => listeners.delete(receive);
    },
    seekLeadership(granted) {
      const withdraw = new AbortController();
      let resign: (() => void) | undefined;
      let done = false;
      void environment.locks
        .request(leaderLockName, { signal: withdraw.signal }, () =>
          done
            ? Promise.resolve()
            : new Promise<void>((release) => {
                leading = true;
                leaderId = id;
                resign = () => {
                  leading = false;
                  leaderId = undefined;
                  release();
                };
                granted();
                for (const listener of [...leadingListeners]) listener();
              }),
        )
        // Withdrawn before it was granted.
        .catch(() => undefined);
      return () => {
        if (done) return;
        done = true;
        if (resign) resign();
        else withdraw.abort();
      };
    },
    onLeading(listener) {
      leadingListeners.add(listener);
      return () => leadingListeners.delete(listener);
    },
  };
}

function randomTabId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}
