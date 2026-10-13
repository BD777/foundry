import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { foundryStreamOpened, onAnyStreamEvent } from "../stream";
import type {
  FoundryData,
  FoundryDataField,
  FoundryStreamEvent,
} from "../api-types";
import {
  applyFoundryStreamEvents,
  compactFoundryStreamEvents,
} from "./foundry-data-projection";
import { streamEventReads } from "./projections";
import type { StreamTouchLedger } from "./stream-touches";
import {
  useLiveDataReads,
  type FoundryDataRead,
  type FoundryDataReadOutcome,
} from "./use-live-data-reads";
import { useStreamRecovery } from "./use-stream-recovery";

export {
  failedReadRetryCapMs,
  streamDownRefreshIntervalMs,
  type FoundryDataRead,
} from "./use-live-data-reads";
export { streamSilenceMs } from "./use-stream-recovery";

/** A hidden tab gets no animation frames; its events apply this often. */
export const hiddenFlushMs = 250;

const noPageFields: readonly FoundryDataField[] = [];

export interface UseFoundryLiveDataInput {
  /** A session or Issue runs: live events are expected. */
  activeSession: boolean;
  /** The devices shown, to tell a device this tab does not list yet. */
  devices: FoundryData["devices"];
  enabled: boolean;
  /**
   * Reads workspace data (see FoundryDataRead); resolves how it went. A
   * read that did not apply (failed, or skipped while a workspace loads)
   * leaves page fields to read again.
   */
  onRefresh: (
    read: FoundryDataRead,
  ) => Promise<FoundryDataReadOutcome> | FoundryDataReadOutcome;
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
  const devicesRef = useRef(devices);
  const workspaceIdRef = useRef(workspaceId);
  devicesRef.current = devices;
  workspaceIdRef.current = workspaceId;
  const [streamDown, setStreamDown] = useState(false);
  const { loadedPageFields, pageRetries, reads } = useLiveDataReads({
    onRefresh,
    pageFields,
  });

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
      for (const field of fields ?? [])
        if (reads.wants(field)) pendingFields.add(field);
      if (!pendingAll && pendingFields.size === 0) return;
      if (changeRefreshTimer !== null) window.clearTimeout(changeRefreshTimer);
      changeRefreshTimer = window.setTimeout(() => {
        changeRefreshTimer = null;
        const all = pendingAll;
        const fields = [...pendingFields];
        pendingAll = false;
        pendingFields.clear();
        void reads.read(all, fields);
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
        onResync: reads.resync,
      },
    );
    // The first read waits for the stream (or its fallback), so it misses
    // no change; a read made before the stream opened is made again on its
    // resync.
    void foundryStreamOpened().then(() => {
      if (!cancelled && !reads.started()) void reads.read(true);
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
    if (enabled) reads.readStale(pageFields);
  }, [enabled, pageKey, pageRetries]);

  useStreamRecovery({
    activeSession,
    enabled,
    reads,
    streamDown,
    workspaceId,
  });

  return loadedPageFields;
}
