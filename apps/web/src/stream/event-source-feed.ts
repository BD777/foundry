/** Waits between reopening a connection the browser gave up on. */
export const foundryStreamReopenDelaysMs = [
  1_000, 2_000, 5_000, 10_000, 30_000,
] as const;

/** EventSource.CLOSED: the browser will not reconnect this source itself. */
const eventSourceClosed = 2;

/** EventSource as the feed uses it. */
export interface StreamEventSource {
  readyState: number;
  onopen: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onmessage: ((message: MessageEvent) => void) | null;
  close(): void;
}

export type StreamEventSourceConstructor = new (
  url: string,
  init?: { withCredentials?: boolean },
) => StreamEventSource;

/** What the connection reports. */
export interface StreamFeedReceiver {
  /** It opened (again). */
  opened(): void;
  /** It stopped delivering; it reconnects by itself. */
  failed(): void;
  /** A message, with its id (`id:`). */
  received(id: string, data: string): void;
}

export interface StreamFeed {
  /** Opens the connection again, resuming after the last message. */
  reconnect(): void;
  close(): void;
}

/**
 * The connection (an EventSource). Every message carries an `id:`; the
 * browser resends the last one as Last-Event-ID when it reconnects by
 * itself, and a connection opened again after the browser gave up passes
 * `resumeFrom()` as `lastEventId`, so the server replays what was missed
 * (or says `resync` when it cannot).
 */
export function openStreamFeed(
  url: string,
  EventSourceClass: StreamEventSourceConstructor,
  resumeFrom: () => string,
  receiver: StreamFeedReceiver,
): StreamFeed {
  let source: StreamEventSource | undefined;
  let reopenTimer: ReturnType<typeof setTimeout> | undefined;
  let reopenAttempts = 0;
  let closed = false;

  function connect(): void {
    if (closed || source || reopenTimer !== undefined) return;
    const from = resumeFrom();
    const current = new EventSourceClass(
      from ? `${url}?lastEventId=${encodeURIComponent(from)}` : url,
      { withCredentials: true },
    );
    source = current;
    current.onopen = () => {
      if (source !== current) return;
      reopenAttempts = 0;
      receiver.opened();
    };
    current.onerror = () => {
      if (source !== current) return;
      receiver.failed();
      // A connection answered with an error status (a proxy's 502 while
      // the server restarts) is closed for good: open a new one, resuming.
      if (current.readyState !== eventSourceClosed) return;
      current.close();
      source = undefined;
      const delays = foundryStreamReopenDelaysMs;
      const delay = delays[Math.min(reopenAttempts, delays.length - 1)]!;
      reopenAttempts += 1;
      reopenTimer = setTimeout(() => {
        reopenTimer = undefined;
        connect();
      }, delay);
    };
    // Every message is unnamed (`data:` only); its envelope says what it is.
    current.onmessage = (message) => {
      if (source !== current) return;
      receiver.received(message.lastEventId, message.data);
    };
  }

  connect();
  return {
    reconnect() {
      if (closed) return;
      if (reopenTimer !== undefined) clearTimeout(reopenTimer);
      reopenTimer = undefined;
      source?.close();
      source = undefined;
      connect();
    },
    close() {
      closed = true;
      if (reopenTimer !== undefined) clearTimeout(reopenTimer);
      reopenTimer = undefined;
      source?.close();
      source = undefined;
    },
  };
}
