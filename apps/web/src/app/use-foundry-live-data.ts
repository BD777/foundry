import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  foundryStreamEpoch,
  foundryStreamOpened,
  foundryStreamQuietMs,
  onAnyStreamEvent,
  reconnectFoundryStream,
} from "../stream";
import type {
  FoundryData,
  FoundryDataField,
  FoundryStreamEvent,
} from "../api-types";
import {
  applyFoundryStreamEvents,
  compactFoundryStreamEvents,
  foundryDataPageFields,
} from "./foundry-data-projection";
import { streamEventReads } from "./projections";
import type { StreamTouchLedger } from "./stream-touches";

/** While the stream is down, workspace data is read this often instead. */
export const streamDownRefreshIntervalMs = 5_000;
/** The longest wait before a read that keeps failing is made again. */
export const failedReadRetryCapMs = 5 * 60_000;
/** A hidden tab gets no animation frames; its events apply this often. */
export const hiddenFlushMs = 250;
/**
 * While something runs, a connection silent this long is opened again,
 * resuming after its last message (it may have died without an error).
 */
export const streamSilenceMs = 60_000;

const noPageFields: readonly FoundryDataField[] = [];

/** A read of workspace data: the default set (`all`) and named fields. */
export interface FoundryDataRead {
  all: boolean;
  fields: readonly FoundryDataField[];
}

export interface UseFoundryLiveDataInput {
  /** A session or Issue runs: live events are expected. */
  activeSession: boolean;
  /** The devices shown, to tell a device this tab does not list yet. */
  devices: FoundryData["devices"];
  enabled: boolean;
  /** Reads workspace data (see FoundryDataRead). */
  /**
   * Reads workspace data (see FoundryDataRead); resolves how it went. A
   * read that did not apply (failed, or skipped while a workspace loads)
   * leaves page fields to read again.
   */
  onRefresh: (
    read: FoundryDataRead,
  ) => Promise<"applied" | "failed" | "skipped" | void> | void;
  /**
   * Fields only some pages read (the skill library's catalog) that the
   * views shown need: read when they first show and whenever they change
   * while they show.
   */
  pageFields?: readonly FoundryDataField[];
  setData: Dispatch<SetStateAction<FoundryData>>;
  /** Notes which entities live events changed (see stream-touches). */
  touches: StreamTouchLedger;
  workspaceId: string;
}

/**
 * Owns transport-level freshness: streamed events are frame-batched and
 * applied in order. The first read waits for the stream to open (see
 * foundryStreamOpened), so every change after it arrives as an event and a
 * page load reads once. A connection that resumes needs no read (the server
 * replays what it missed); data read before an epoch the stream started
 * (a resync, a connection with nowhere to resume from) is read again.
 * What an event leaves to a read (see StreamProjection.reads) is read after
 * a short quiet period (one read per burst), in hidden tabs too, so a tab
 * shows current data when it comes back. Reads poll only while the stream
 * is down. Returns the page fields read at least once.
 * Feature components never see this layer.
 */
export function useFoundryLiveData({
  activeSession,
  devices,
  enabled,
  onRefresh,
  pageFields = noPageFields,
  setData,
  touches,
  workspaceId,
}: UseFoundryLiveDataInput): ReadonlySet<FoundryDataField> {
  const refreshRef = useRef(onRefresh);
  const devicesRef = useRef(devices);
  const workspaceIdRef = useRef(workspaceId);
  const pageFieldsRef = useRef(pageFields);
  const lastRefreshAtRef = useRef(Date.now());
  /** The epoch the last whole read started at; undefined before the first. */
  const readEpochRef = useRef<number | undefined>(undefined);
  /** Page fields current since the epoch they were read at. */
  const pageEpochsRef = useRef(new Map<FoundryDataField, number>());
  const [loadedPageFields, setLoadedPageFields] = useState<
    ReadonlySet<FoundryDataField>
  >(() => new Set());
  const [streamDown, setStreamDown] = useState(false);
  /** A read that did not apply waits on this timer to be made again. */
  const retryRef = useRef({
    timer: null as number | null,
    whole: false,
    failures: 0,
  });
  const [pageRetries, setPageRetries] = useState(0);
  refreshRef.current = onRefresh;
  devicesRef.current = devices;
  workspaceIdRef.current = workspaceId;
  pageFieldsRef.current = pageFields;
  /**
   * Reads the default set (`all`) and the given fields, adding the shown
   * page fields not current at this epoch to a whole read.
   */
  const readLatest = useRef(
    (all: boolean, fields: readonly FoundryDataField[] = []) => {
      const epoch = foundryStreamEpoch();
      const page = new Set(
        fields.filter((field) => foundryDataPageFields.includes(field)),
      );
      if (all) {
        readEpochRef.current = epoch;
        for (const field of pageFieldsRef.current)
          if (pageEpochsRef.current.get(field) !== epoch) page.add(field);
      }
      page.forEach((field) => pageEpochsRef.current.set(field, epoch));
      lastRefreshAtRef.current = Date.now();
      const read = { all, fields: [...new Set([...fields, ...page])] };
      const done = (outcome: string | void) => {
        if (outcome === undefined || outcome === "applied") {
          retryRef.current.failures = 0;
          // A whole read that applied makes a waiting whole retry needless.
          if (all) retryRef.current.whole = false;
          if (page.size > 0)
            setLoadedPageFields((loaded) =>
              [...page].every((field) => loaded.has(field))
                ? loaded
                : new Set([...loaded, ...page]),
            );
          return;
        }
        // Not read (failed, or skipped while a workspace loads): not
        // current, and read again after a wait that grows while reads fail.
        for (const field of page)
          if (pageEpochsRef.current.get(field) === epoch)
            pageEpochsRef.current.delete(field);
        const retry = retryRef.current;
        if (all && outcome === "failed") retry.whole = true;
        if (page.size === 0 && !retry.whole) return;
        if (retry.timer !== null) return;
        retry.failures += 1;
        retry.timer = window.setTimeout(
          () => {
            retry.timer = null;
            if (retry.whole) {
              retry.whole = false;
              void readLatest.current(true);
            } else setPageRetries((count) => count + 1);
          },
          Math.min(
            streamDownRefreshIntervalMs * 3 ** (retry.failures - 1),
            failedReadRetryCapMs,
          ),
        );
      };
      return Promise.resolve(refreshRef.current(read)).then(done, () =>
        done("failed"),
      );
    },
  );

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    let frameId: number | null = null;
    let hiddenFlushTimer: number | null = null;
    let changeRefreshTimer: number | null = null;
    let cancelled = false;
    /** Fields announced changed, to read after the quiet period. */
    let pendingAll = false;
    const pendingFields = new Set<FoundryDataField>();
    const pendingEvents: FoundryStreamEvent[] = [];
    const flushPending = (): void => {
      frameId = null;
      hiddenFlushTimer = null;
      if (pendingEvents.length === 0) {
        return;
      }
      const events = compactFoundryStreamEvents(pendingEvents.splice(0));
      // This projection is also updated by synchronous HTTP hydration. Mixing
      // transition and regular updates rebases those hydration reducers while
      // Virtuoso/Radix publish synchronous updates, preventing convergence.
      // Frame batching already bounds the update rate; keep one priority for
      // all writes to this shared snapshot.
      setData((current) => applyFoundryStreamEvents(current, events));
    };
    // Browsers pause animation frames in hidden tabs; a timer keeps their
    // state (and the tab title) following the stream.
    const scheduleFrame = (): void => {
      if (frameId !== null || hiddenFlushTimer !== null) return;
      if (document.visibilityState === "hidden")
        hiddenFlushTimer = window.setTimeout(flushPending, hiddenFlushMs);
      else frameId = window.requestAnimationFrame(flushPending);
    };
    // A frame requested just before the tab hid would wait until it shows.
    const handleHidden = (): void => {
      if (document.visibilityState !== "hidden" || frameId === null) return;
      window.cancelAnimationFrame(frameId);
      frameId = null;
      scheduleFrame();
    };
    document.addEventListener("visibilitychange", handleHidden);
    // Device and data changes share one timer: a burst of either reads once.
    const refreshAfterQuiet = (
      delayMs: number,
      fields?: readonly FoundryDataField[],
    ): void => {
      if (!fields) pendingAll = true;
      for (const field of fields ?? []) {
        // A page field no view shows is read when one shows it again.
        if (
          foundryDataPageFields.includes(field) &&
          !pageFieldsRef.current.includes(field)
        )
          pageEpochsRef.current.delete(field);
        else pendingFields.add(field);
      }
      if (!pendingAll && pendingFields.size === 0) return;
      if (changeRefreshTimer !== null) window.clearTimeout(changeRefreshTimer);
      changeRefreshTimer = window.setTimeout(() => {
        changeRefreshTimer = null;
        const all = pendingAll;
        const fields = [...pendingFields];
        pendingAll = false;
        pendingFields.clear();
        void readLatest.current(all, fields);
      }, delayMs);
    };
    const unsubscribe = onAnyStreamEvent(
      (event, receivedAt) => {
        touches.record(event, receivedAt);
        pendingEvents.push(event);
        scheduleFrame();
        const read = streamEventReads(event, {
          workspaceId: workspaceIdRef.current,
          devices: devicesRef.current,
        });
        if (read) refreshAfterQuiet(read.delayMs, read.fields);
      },
      {
        onError: () => setStreamDown(true),
        onOpen: () => setStreamDown(false),
        // Events may be missing: what was read before the epoch began is
        // read again. Transcripts reload their own recent window.
        onResync: () => {
          const read = readEpochRef.current;
          const epoch = foundryStreamEpoch();
          for (const [field, at] of pageEpochsRef.current)
            if (at < epoch && !pageFieldsRef.current.includes(field))
              pageEpochsRef.current.delete(field);
          if (read !== undefined && read < epoch) void readLatest.current(true);
        },
      },
    );
    // The first read waits for the stream (or its fallback), so it misses
    // no change; a read made before the stream opened is made again on its
    // resync.
    void foundryStreamOpened().then(() => {
      if (!cancelled && readEpochRef.current === undefined)
        void readLatest.current(true);
    });
    return () => {
      cancelled = true;
      unsubscribe();
      document.removeEventListener("visibilitychange", handleHidden);
      if (changeRefreshTimer !== null) window.clearTimeout(changeRefreshTimer);
      if (hiddenFlushTimer !== null) window.clearTimeout(hiddenFlushTimer);
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [enabled, setData, touches]);

  // A page field a view now shows is read unless it is current.
  const pageKey = pageFields.join(",");
  useEffect(() => {
    if (!enabled || readEpochRef.current === undefined) return;
    const epoch = foundryStreamEpoch();
    const stale = pageFields.filter(
      (field) => pageEpochsRef.current.get(field) !== epoch,
    );
    if (stale.length) void readLatest.current(false, stale);
  }, [enabled, pageKey, pageRetries]);
  useEffect(
    () => () => {
      const retry = retryRef.current;
      if (retry.timer !== null) window.clearTimeout(retry.timer);
      retry.timer = null;
    },
    [],
  );

  // While the stream is down nothing announces changes: read every few
  // seconds. A hidden tab skips its polls; coming back it catches up only
  // if one was due.
  useEffect(() => {
    if (!enabled || !streamDown) {
      return undefined;
    }
    let canceled = false;
    let timerId: number | null = null;
    const schedule = (): void => {
      timerId = window.setTimeout(async () => {
        if (document.visibilityState === "visible") {
          await readLatest.current(true);
        }
        if (!canceled) {
          schedule();
        }
      }, streamDownRefreshIntervalMs);
    };
    const handleVisibilityChange = (): void => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastRefreshAtRef.current >= streamDownRefreshIntervalMs
      ) {
        void readLatest.current(true);
      }
    };
    schedule();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      canceled = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled, streamDown, workspaceId]);

  // The server's keepalives are invisible to a page, so a connection that
  // died without an error looks open. Back online, or silent while something
  // runs: open it again. It resumes after its last message (no read).
  useEffect(() => {
    if (!enabled) return undefined;
    window.addEventListener("online", reconnectFoundryStream);
    const watchdog =
      activeSession && !streamDown
        ? window.setInterval(() => {
            if (
              document.visibilityState === "visible" &&
              foundryStreamQuietMs() >= streamSilenceMs
            )
              reconnectFoundryStream();
          }, streamSilenceMs / 4)
        : null;
    return () => {
      window.removeEventListener("online", reconnectFoundryStream);
      if (watchdog !== null) window.clearInterval(watchdog);
    };
  }, [activeSession, enabled, streamDown]);

  return loadedPageFields;
}
