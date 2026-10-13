import { useEffect, useState } from "react";
import { browserEventTypes, type ResourceList } from "@bd777/foundry-protocol";
import { isAbortError, listResources, type ResourceListQuery } from "../api";
import { onStreamEvent } from "../stream";

export interface ResourceInventory {
  list?: ResourceList;
  /** Why the latest read failed; the last list read stays shown. */
  error: string;
  loading: boolean;
  /** Reads the inventory again at once. */
  reload: () => void;
}

/**
 * The resource inventory while it is shown: read on open, again when a
 * source's resources change (only that device's, for a device query) and
 * on what the event stream may have missed.
 */
export function useResourceInventory(
  query: ResourceListQuery = {},
): ResourceInventory {
  const { type, device, includeGone } = query;
  const [state, setState] = useState<Omit<ResourceInventory, "reload">>({
    error: "",
    loading: true,
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    let reading = false;
    let readAgain = false;
    const controller = new AbortController();
    const read = async () => {
      if (reading) {
        readAgain = true;
        return;
      }
      reading = true;
      try {
        const list = await listResources(
          { type, device, includeGone },
          { signal: controller.signal },
        );
        if (active) setState({ list, error: "", loading: false });
      } catch (reason) {
        if (active && !isAbortError(reason))
          setState((current) => ({
            ...current,
            error: reason instanceof Error ? reason.message : String(reason),
            loading: false,
          }));
      } finally {
        reading = false;
      }
      if (active && readAgain) {
        readAgain = false;
        void read();
      }
    };
    const stop = onStreamEvent(
      browserEventTypes.resourcesChanged,
      (change) => {
        if (!device || change.sourceId === device) void read();
      },
      { onResync: () => void read() },
    );
    setState((current) => ({ ...current, loading: true }));
    void read();
    return () => {
      active = false;
      controller.abort();
      stop();
    };
  }, [type, device, includeGone, attempt]);

  return { ...state, reload: () => setAttempt((count) => count + 1) };
}
