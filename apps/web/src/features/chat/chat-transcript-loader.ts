import type {
  CaughtUpAgentSession,
  TranscriptLoadProgress,
  WindowedAgentSession,
} from "../../api";

/** How many recent events of each session the first load asks for. */
export const transcriptWindowEvents = 200;
/** After this long a load says it is still going and offers a retry. */
export const transcriptSlowAfterMs = 10_000;
/** A detected gap is repaired at most this often (SSE carries the rest). */
export const transcriptRepairIntervalMs = 30_000;
const retryDelaysMs = [500, 1_500, 5_000, 10_000] as const;
const missingRetryMs = 5_000;

export interface TranscriptLoadState {
  threadId?: string;
  loading: boolean;
  /** Loading for longer than transcriptSlowAfterMs. */
  slow: boolean;
  /** The last attempt failed; another is scheduled. */
  failed: boolean;
  progress?: TranscriptLoadProgress;
  /** Sessions with older events not loaded yet, and where those start. */
  earlier: Readonly<Record<string, string>>;
  loadingEarlier: boolean;
  earlierFailed: boolean;
}

export interface TranscriptLoaderTransport {
  loadRecent: (
    threadId: string,
    options: {
      signal: AbortSignal;
      onProgress: (progress: TranscriptLoadProgress) => void;
    },
  ) => Promise<WindowedAgentSession[]>;
  loadEarlier: (
    sessionId: string,
    before: string,
    signal: AbortSignal,
  ) => Promise<WindowedAgentSession>;
  /**
   * The session's events after `after` (a cursor a load returned), at most
   * a window's worth (`eventsMore` beyond). Without it, a repair reloads the
   * recent window.
   */
  loadAfter?: (
    sessionId: string,
    after: string,
    signal: AbortSignal,
  ) => Promise<CaughtUpAgentSession>;
}

export interface TranscriptLoaderOptions {
  transport: TranscriptLoaderTransport;
  /** Merges loaded sessions into what is shown (append-only). */
  onLoaded: (sessions: WindowedAgentSession[]) => void;
  onState: (state: TranscriptLoadState) => void;
  /**
   * Resolves when a read may start (see foundryStreamOpened): a selection's
   * first load waits for it. Without it loads start at once.
   */
  opened?: () => Promise<unknown>;
  /**
   * The stream's epoch (see foundryStreamEpoch): a resync loads only when
   * the last load started at an older one. Without it every resync loads.
   */
  epoch?: () => number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export type TranscriptLoadReason = "missing" | "stale" | "resync" | "retry";

const idle = (threadId?: string): TranscriptLoadState => ({
  threadId,
  loading: false,
  slow: false,
  failed: false,
  earlier: {},
  loadingEarlier: false,
  earlierFailed: false,
});

/**
 * Loads a chat's transcript: the most recent window first, older pages on
 * request. Live events never abort a load (they are merged in by the
 * caller); only leaving the chat or an explicit retry does. A reason to load
 * again while a load runs (a resync, a detected gap) runs once after it.
 * Such a repair reads only the events after the newest each session holds
 * (loadAfter), and reloads the window when one cannot catch up (no cursor,
 * one the server no longer knows, or more than a window behind).
 */
export function createTranscriptLoader(options: TranscriptLoaderOptions) {
  const now = options.now ?? (() => Date.now());
  const setTimer =
    options.setTimer ??
    ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ??
    ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let state = idle();
  let controller: AbortController | undefined;
  let earlierController: AbortController | undefined;
  let slowTimer: unknown;
  let retryTimer: unknown;
  let again = false;
  let attempt = 0;
  let lastLoadedAt = Number.NEGATIVE_INFINITY;
  /** A load started for the chat shown. */
  let begun = false;
  /** The epoch the latest load started at; +∞ while one waits to start. */
  let loadEpoch = Number.NEGATIVE_INFINITY;
  /**
   * Where each session of the chat catches up from: the newest event a
   * window or a catch-up returned; undefined for one a window returned
   * empty. Empty until the first load.
   */
  let cursors = new Map<string, string | undefined>();

  function publish(next: Partial<TranscriptLoadState>) {
    state = { ...state, ...next };
    options.onState(state);
  }
  function stopTimers() {
    if (slowTimer !== undefined) clearTimer(slowTimer);
    if (retryTimer !== undefined) clearTimer(retryTimer);
    slowTimer = retryTimer = undefined;
  }

  /** The events after each session's cursor; undefined: reload instead. */
  async function catchUp(
    signal: AbortSignal,
  ): Promise<WindowedAgentSession[] | undefined> {
    const loadAfter = options.transport.loadAfter;
    const from = [...cursors];
    if (!loadAfter || from.length === 0) return undefined;
    if (from.some(([, after]) => after === undefined)) return undefined;
    try {
      const sessions = await Promise.all(
        from.map(([sessionId, after]) => loadAfter(sessionId, after!, signal)),
      );
      return sessions.some((session) => session.eventsMore)
        ? undefined
        : sessions;
    } catch (error) {
      if (signal.aborted) throw error;
      // A cursor the server no longer knows: reload instead.
      return undefined;
    }
  }

  function start(threadId: string, repair = false) {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    again = false;
    if (retryTimer !== undefined) clearTimer(retryTimer);
    retryTimer = undefined;
    if (slowTimer === undefined) {
      slowTimer = setTimer(() => {
        slowTimer = undefined;
        if (controller === current || state.failed) publish({ slow: true });
      }, transcriptSlowAfterMs);
    }
    publish({ loading: true, progress: undefined });
    const recent = () => {
      loadEpoch = options.epoch?.() ?? 0;
      return options.transport.loadRecent(threadId, {
        signal: current.signal,
        onProgress: (progress) => {
          if (controller === current) publish({ progress });
        },
      });
    };
    /** A repair catches up when it can; its sessions replace no cursor. */
    let caughtUp = false;
    const load = (): Promise<WindowedAgentSession[]> => {
      if (!repair) return recent();
      loadEpoch = options.epoch?.() ?? 0;
      return catchUp(current.signal).then((sessions) => {
        if (!sessions) return recent();
        caughtUp = true;
        return sessions;
      });
    };
    // The chat's first load starts once the stream opened, so the stream
    // carries every change after it; a resync meanwhile needs no load.
    const opened = begun ? undefined : options.opened?.();
    begun = true;
    if (opened) loadEpoch = Number.POSITIVE_INFINITY;
    void (
      opened
        ? opened.then(() => (controller === current ? load() : []))
        : load()
    ).then(
      (sessions) => {
        if (controller !== current) return;
        controller = undefined;
        attempt = 0;
        // A repair load shows nothing older than the first one did: where
        // older pages continue stays as the first load (or paging) left it.
        const first = !Number.isFinite(lastLoadedAt);
        lastLoadedAt = now();
        stopTimers();
        const earlier: Record<string, string> = first
          ? {}
          : { ...state.earlier };
        if (first) {
          for (const session of sessions) {
            if (session.eventsBefore)
              earlier[session.id] = session.eventsBefore;
          }
        }
        // A window names where each of its sessions continues; a session
        // it returns without one (no events) cannot catch up.
        if (!caughtUp) cursors = new Map();
        for (const session of sessions)
          cursors.set(session.id, session.eventsAfter);
        publish({
          loading: false,
          slow: false,
          failed: false,
          progress: undefined,
          earlier,
        });
        if (sessions.length > 0) options.onLoaded(sessions);
        if (again) start(threadId, true);
      },
      () => {
        if (controller !== current) return;
        controller = undefined;
        const delay =
          retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] ?? 10_000;
        attempt += 1;
        publish({ loading: false, failed: true });
        retryTimer = setTimer(() => {
          retryTimer = undefined;
          if (state.threadId === threadId) start(threadId);
        }, delay);
      },
    );
  }

  return {
    /** The chat shown; changing it is the only thing that drops a load. */
    select(threadId: string | undefined) {
      if (threadId === state.threadId) return;
      controller?.abort();
      earlierController?.abort();
      controller = earlierController = undefined;
      stopTimers();
      attempt = 0;
      again = false;
      lastLoadedAt = Number.NEGATIVE_INFINITY;
      begun = false;
      loadEpoch = Number.NEGATIVE_INFINITY;
      cursors = new Map();
      state = idle(threadId);
      options.onState(state);
    },
    request(reason: TranscriptLoadReason) {
      const threadId = state.threadId;
      if (!threadId) return;
      // What is loaded (or loading) is no older than the resync.
      if (reason === "resync" && options.epoch && options.epoch() <= loadEpoch)
        return;
      if (reason === "retry") {
        attempt = 0;
        start(threadId);
        return;
      }
      if (
        reason === "stale" &&
        now() - lastLoadedAt < transcriptRepairIntervalMs
      )
        return;
      if (controller || retryTimer !== undefined) {
        // Never abort a running load for newer events; load once more after.
        if (reason !== "missing") again = true;
        return;
      }
      // A session the last load did not return is not asked for in a loop.
      if (reason === "missing" && now() - lastLoadedAt < missingRetryMs) return;
      start(threadId, reason === "resync" || reason === "stale");
    },
    loadEarlier() {
      const entry = Object.entries(state.earlier)[0];
      if (!entry || earlierController) return;
      const [sessionId, before] = entry;
      const current = new AbortController();
      earlierController = current;
      publish({ loadingEarlier: true, earlierFailed: false });
      void options.transport
        .loadEarlier(sessionId, before, current.signal)
        .then(
          (session) => {
            if (earlierController !== current) return;
            earlierController = undefined;
            const earlier = { ...state.earlier };
            if (session.eventsBefore && session.eventsBefore !== before)
              earlier[sessionId] = session.eventsBefore;
            else delete earlier[sessionId];
            publish({ loadingEarlier: false, earlier });
            options.onLoaded([session]);
          },
          () => {
            if (earlierController !== current) return;
            earlierController = undefined;
            publish({ loadingEarlier: false, earlierFailed: true });
          },
        );
    },
    dispose() {
      controller?.abort();
      earlierController?.abort();
      stopTimers();
    },
  };
}

export type TranscriptLoader = ReturnType<typeof createTranscriptLoader>;
