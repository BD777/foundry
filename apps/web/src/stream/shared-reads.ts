// Reads that every tab makes when the same thing happens (an event that
// leaves a read, a resync, a page load) are made once for the browser:
// the tab that leads the stream reads, single-flight per path, and every
// tab keeps each answer it hears. A tab uses an answer it holds when it
// shows everything the stream announced to the tab and the tab's own
// writes (see read); otherwise it asks the leader, which reads unless it
// is reading already. Each read is conditional on the answer held
// (If-None-Match), so an unchanged one costs a 304. Where tabs cannot
// coordinate, each read is made here, as before, conditionally.

import type { ReceivedTabMessage, SharedAnswer, Tabs } from "./tabs";

export type { SharedAnswer } from "./tabs";

/**
 * An answer started this long ago or less may serve a later read, when
 * the stream announced no change meanwhile: tabs reacting to one event
 * read within that time of each other, and what the stream does not
 * announce stays at most this stale.
 */
export const sharedReadReuseMs = 2_000;

/** How many paths' answers a tab keeps. */
const heldAnswers = 32;

/** A GET as tabs share it: `etag` makes it conditional ("" for none). */
export type SharedReadFetch = (
  path: string,
  etag: string,
  signal: AbortSignal,
) => Promise<{ status: number; etag: string; body: string }>;

export interface SharedReadsOptions {
  /** The stream: who leads, and what it announced (see readFloor). */
  stream: { tabs: () => Tabs | undefined; readFloor: () => number };
  fetch: SharedReadFetch;
  /** A read that takes longer fails (see backgroundReadTimeoutMs). */
  timeoutMs: number;
}

interface Flight {
  requestedAt: number;
  promise: Promise<SharedAnswer>;
  /** Asks of other tabs this read answers. */
  requests: Set<string>;
  /** One more read after this one, for those who need a later one. */
  next?: { promise: Promise<SharedAnswer>; requests: Set<string> };
}

interface Ask {
  key: string;
  since: number;
  resolve: (answer: SharedAnswer) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createSharedReads({
  stream,
  fetch,
  timeoutMs,
}: SharedReadsOptions) {
  /** The newest successful answer of each path, oldest path first. */
  const answers = new Map<string, SharedAnswer>();
  /** The reads this tab makes for every tab, by path. */
  const flights = new Map<string, Flight>();
  /** This tab's reads asked of the leader, by request id. */
  const asks = new Map<string, Ask>();
  let lastWriteAt = 0;
  let listening: Tabs | undefined;

  function remember(key: string, answer: SharedAnswer): void {
    if (answer.status < 200 || answer.status >= 300) return;
    const held = answers.get(key);
    if (held && held.requestedAt > answer.requestedAt) return;
    answers.delete(key);
    answers.set(key, answer);
    if (answers.size > heldAnswers)
      answers.delete(answers.keys().next().value!);
  }

  /** The read, conditional on the answer held; 304 answers with it. */
  async function fetchAnswer(
    key: string,
    signal: AbortSignal,
  ): Promise<SharedAnswer> {
    const held = answers.get(key);
    const requestedAt = Date.now();
    const response = await fetch(key, held?.etag ?? "", signal);
    const answer =
      response.status === 304 && held
        ? { ...held, requestedAt }
        : { ...response, requestedAt };
    remember(key, answer);
    return answer;
  }

  /** Reads `key` for this tab and the tabs that asked; tells them all. */
  function start(key: string, requests: Set<string>): Flight {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new DOMException(`No answer within ${timeoutMs} ms`, "TimeoutError"),
        ),
      timeoutMs,
    );
    const flight: Flight = {
      requestedAt: Date.now(),
      requests,
      promise: undefined as unknown as Promise<SharedAnswer>,
    };
    flight.promise = fetchAnswer(key, controller.signal)
      .then(
        (answer) => {
          listening?.post({
            kind: "answer",
            key,
            answer,
            requests: [...requests],
          });
          return answer;
        },
        (error: unknown) => {
          listening?.post({
            kind: "read-failed",
            key,
            requests: [...requests],
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        },
      )
      .finally(() => {
        clearTimeout(timer);
        if (flights.get(key) === flight) flights.delete(key);
      });
    flights.set(key, flight);
    return flight;
  }

  /**
   * An answer to `key` that started at `since` or later: the read running
   * when it did, else one more after it (one for every such caller), else
   * a new one.
   */
  function execute(
    key: string,
    since: number,
    request?: string,
  ): Promise<SharedAnswer> {
    const flight = flights.get(key);
    if (!flight) return start(key, new Set(request ? [request] : [])).promise;
    if (flight.requestedAt >= since) {
      if (request) flight.requests.add(request);
      return flight.promise;
    }
    if (!flight.next) {
      const requests = new Set<string>();
      const promise = flight.promise.then(
        () => start(key, requests).promise,
        () => start(key, requests).promise,
      );
      flight.next = { promise, requests };
    }
    if (request) flight.next.requests.add(request);
    return flight.next.promise;
  }

  /** Asks the leader; made here if it does not answer in time. */
  function ask(tabs: Tabs, key: string, since: number): Promise<SharedAnswer> {
    const request = randomRequestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        asks.delete(request);
        execute(key, since).then(resolve, reject);
      }, timeoutMs + 5_000);
      asks.set(request, { key, since, resolve, reject, timer });
      tabs.post({ kind: "read", key, since, request });
    });
  }

  function settleAsk(request: string, settle: (ask: Ask) => void): void {
    const pending = asks.get(request);
    if (!pending) return;
    asks.delete(request);
    clearTimeout(pending.timer);
    settle(pending);
  }

  /** Asks still unanswered go to whoever leads now, or are made here. */
  function rerouteAsks(): void {
    const tabs = listening;
    for (const [request, pending] of [...asks]) {
      if (tabs?.leaderElsewhere()) {
        tabs.post({
          kind: "read",
          key: pending.key,
          since: pending.since,
          request,
        });
        continue;
      }
      settleAsk(request, ({ key, since, resolve, reject }) =>
        execute(key, since).then(resolve, reject),
      );
    }
  }

  function receive(message: ReceivedTabMessage, fromLeader: boolean): void {
    switch (message.kind) {
      case "read": {
        if (!listening?.leading()) return;
        const held = answers.get(message.key);
        if (held && held.requestedAt >= message.since)
          listening.post({
            kind: "answer",
            key: message.key,
            answer: held,
            requests: [message.request],
          });
        // A failure is told to every tab that asked (see start).
        else
          execute(message.key, message.since, message.request).catch(
            () => undefined,
          );
        return;
      }
      case "answer":
        remember(message.key, message.answer);
        for (const [request, pending] of [...asks])
          if (
            message.requests.includes(request) ||
            (pending.key === message.key &&
              message.answer.requestedAt >= pending.since)
          )
            settleAsk(request, ({ resolve }) => resolve(message.answer));
        return;
      case "read-failed":
        for (const request of message.requests)
          settleAsk(request, ({ reject }) =>
            reject(new Error(message.message)),
          );
        return;
      case "signed-out":
        answers.clear();
        return;
      case "leader":
        rerouteAsks();
        return;
      case "resign":
        if (fromLeader) rerouteAsks();
        return;
    }
  }

  // A leader answers the reads other tabs ask for, whether or not it reads.
  const joined = stream.tabs();
  if (joined) {
    listening = joined;
    joined.listen(receive);
    joined.onLeading(rerouteAsks);
  }

  return {
    /**
     * Reads `key` (a GET path). With other tabs, an answer that started no
     * earlier than every change this tab knows of serves it: the stream's
     * (readFloor), this tab's last write, and sharedReadReuseMs ago. The
     * read is made here when this tab leads or no tab does; else the
     * leader is asked. `signal` ends only this caller's wait. An answer
     * may be any HTTP status; a failed request rejects.
     */
    read(key: string, signal?: AbortSignal): Promise<SharedAnswer> {
      const tabs = listening;
      if (!tabs)
        return fetchAnswer(key, signal ?? new AbortController().signal);
      const since = Math.max(
        stream.readFloor(),
        lastWriteAt,
        Date.now() - sharedReadReuseMs,
      );
      const held = answers.get(key);
      if (held && held.requestedAt >= since) return Promise.resolve(held);
      return abortable(
        tabs.leaderElsewhere() ? ask(tabs, key, since) : execute(key, since),
        signal,
      );
    },

    /** This tab changed something: later reads must start after now. */
    wrote(): void {
      lastWriteAt = Date.now();
    },

    /** The person signed out: no answer read for them serves anyone. */
    forget(): void {
      answers.clear();
    },
  };
}

export type SharedReads = ReturnType<typeof createSharedReads>;

/** `promise`, rejected when `signal` aborts first. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function randomRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}
