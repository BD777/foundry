import { useEffect } from "react";
import { foundryStreamQuietMs, reconnectFoundryStream } from "../stream";
import {
  streamDownRefreshIntervalMs,
  type LiveDataReads,
} from "./use-live-data-reads";

/**
 * While something runs, a connection silent this long is opened again,
 * resuming after its last message (it may have died without an error).
 */
export const streamSilenceMs = 60_000;

export interface UseStreamRecoveryInput {
  /** A session or Issue runs: live events are expected. */
  activeSession: boolean;
  enabled: boolean;
  reads: LiveDataReads;
  streamDown: boolean;
  workspaceId: string;
}

/**
 * Keeps data fresh when the stream fails: polls while it is down, and opens
 * it again when the browser comes back online or it falls silent.
 */
export function useStreamRecovery({
  activeSession,
  enabled,
  reads,
  streamDown,
  workspaceId,
}: UseStreamRecoveryInput): void {
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
          await reads.read(true);
        }
        if (!canceled) {
          schedule();
        }
      }, streamDownRefreshIntervalMs);
    };
    const handleVisibilityChange = (): void => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - reads.lastReadAt() >= streamDownRefreshIntervalMs
      ) {
        void reads.read(true);
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
}
