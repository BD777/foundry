import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { subscribeFoundryEvents } from "../api";
import type { FoundryData, FoundryStreamEvent } from "../api-types";
import {
  applyFoundryStreamEvent,
  compactFoundryStreamEvents,
} from "./foundry-data-projection";

export interface UseFoundryLiveDataInput {
  activeSession: boolean;
  enabled: boolean;
  onRefresh: () => Promise<void> | void;
  setData: Dispatch<SetStateAction<FoundryData>>;
  workspaceId: string;
}

/**
 * Owns transport-level freshness: streamed events are frame-batched and a
 * slower poll repairs missed events. Feature components never see this layer.
 */
export function useFoundryLiveData({
  activeSession,
  enabled,
  onRefresh,
  setData,
  workspaceId,
}: UseFoundryLiveDataInput): void {
  const refreshRef = useRef(onRefresh);
  const [streamConnected, setStreamConnected] = useState(false);
  refreshRef.current = onRefresh;

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    let frameId: number | null = null;
    const pendingEvents: FoundryStreamEvent[] = [];
    const flushPending = (): void => {
      frameId = null;
      if (pendingEvents.length === 0) {
        return;
      }
      const events = compactFoundryStreamEvents(pendingEvents.splice(0));
      // This projection is also updated by synchronous HTTP hydration. Mixing
      // transition and regular updates rebases those hydration reducers while
      // Virtuoso/Radix publish synchronous updates, preventing convergence.
      // Frame batching already bounds the update rate; keep one priority for
      // all writes to this shared snapshot.
      setData((current) => {
        let next = current;
        for (const event of events) {
          next = applyFoundryStreamEvent(next, event);
        }
        return next;
      });
    };
    const scheduleFrame = (): void => {
      if (frameId === null) {
        frameId = window.requestAnimationFrame(flushPending);
      }
    };
    const unsubscribe = subscribeFoundryEvents(
      (event) => {
        pendingEvents.push(event);
        scheduleFrame();
      },
      {
        onError: () => {
          setStreamConnected(false);
          void refreshRef.current();
        },
        onOpen: () => {
          setStreamConnected(true);
          void refreshRef.current();
        },
      },
    );
    return () => {
      unsubscribe();
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [enabled, setData]);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    let canceled = false;
    let timerId: number | null = null;
    const intervalMs = streamConnected
      ? activeSession
        ? 30_000
        : 60_000
      : 5_000;
    const schedule = (): void => {
      timerId = window.setTimeout(async () => {
        if (document.visibilityState === "visible") {
          await refreshRef.current();
        }
        if (!canceled) {
          schedule();
        }
      }, intervalMs);
    };
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        void refreshRef.current();
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
  }, [activeSession, enabled, streamConnected, workspaceId]);
}
