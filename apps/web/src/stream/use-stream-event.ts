import { useEffect, useRef } from "react";
import type {
  BrowserEventPayloads,
  BrowserEventType,
} from "@bd777/foundry-protocol";
import {
  onStreamEvent,
  type FoundryStreamResync,
  type StreamEventOptions,
} from "./foundry-stream";

export interface UseStreamEventOptions<
  K extends BrowserEventType,
> extends StreamEventOptions<K> {
  /**
   * Events may be missing (see FoundryStreamLifecycle.onResync): what the
   * component keeps from them is read again. Required: state kept from
   * events goes stale without it until the component mounts again.
   */
  onResync: (resync: FoundryStreamResync) => void;
}

/**
 * Follows the events of one type while the component is mounted (see
 * onStreamEvent). The newest handler and callbacks are called; it subscribes
 * again only when the type or the workspace changes.
 */
export function useStreamEvent<K extends BrowserEventType>(
  type: K,
  handler: (payload: BrowserEventPayloads[K]) => void,
  options: UseStreamEventOptions<K>,
): void {
  const latest = useRef({ handler, options });
  latest.current = { handler, options };
  const { workspaceId } = options;
  useEffect(
    () =>
      onStreamEvent(type, (payload) => latest.current.handler(payload), {
        workspaceId,
        onError: () => latest.current.options.onError?.(),
        onOpen: () => latest.current.options.onOpen?.(),
        onResync: (resync) => latest.current.options.onResync(resync),
      }),
    [type, workspaceId],
  );
}
