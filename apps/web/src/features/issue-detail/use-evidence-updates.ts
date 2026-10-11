import { useCallback, useEffect, useRef } from "react";
import {
  foundryStreamEpoch,
  foundryStreamOpened,
  onStreamEvent,
} from "../../stream";

/**
 * SSE contains IDs/status only; fetch the authoritative review after a burst,
 * or after a resync newer than the last load (events may be missing).
 * Returns the caller's own load (on mount, or when what it shows changed):
 * it starts once the stream opened, so it misses nothing the stream sends
 * after. Calling it from an effect returns the effect's cleanup, which drops
 * a load not started yet.
 */
export function useEvidenceUpdates(
  issueId: string,
  refresh: () => Promise<void>,
  onError: (message: string) => void,
): () => () => void {
  const refreshRef = useRef(refresh);
  const errorRef = useRef(onError);
  refreshRef.current = refresh;
  errorRef.current = onError;
  /** The epoch the last load started at; +∞ while one waits to start. */
  const loadedAt = useRef(Number.NEGATIVE_INFINITY);
  const run = useCallback(() => {
    loadedAt.current = foundryStreamEpoch();
    return refreshRef.current();
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (active)
          void run().catch((error) => {
            if (active) errorRef.current(String(error));
          });
      }, 100);
    };
    const close = onStreamEvent(
      "evidence_updated",
      (payload) => {
        if (payload.issueId === issueId) schedule();
      },
      {
        onResync: () => {
          if (loadedAt.current < foundryStreamEpoch()) schedule();
        },
      },
    );
    return () => {
      active = false;
      clearTimeout(timer);
      close();
    };
  }, [issueId, run]);
  return useCallback(() => {
    let cancelled = false;
    loadedAt.current = Number.POSITIVE_INFINITY;
    void foundryStreamOpened().then(() => {
      if (!cancelled)
        void run().catch((error) => errorRef.current(String(error)));
    });
    return () => {
      cancelled = true;
    };
  }, [issueId, run]);
}
