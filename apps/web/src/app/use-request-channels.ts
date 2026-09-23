import { useEffect, useRef } from "react";

/** Named channel whose in-flight request is superseded by the next one. */
export type RequestChannel = "file-read" | "workspace-load";

export interface RequestChannels {
  /** Aborts the in-flight request on a channel without starting a new one. */
  abort: (channel: RequestChannel) => void;
  /** Aborts the previous request on a channel and scopes the next one. */
  signalFor: (channel: RequestChannel) => AbortSignal;
}

/**
 * Keeps latest-wins request channels honest: a superseded read is cancelled at
 * the transport level instead of resolving into state the user no longer wants,
 * and unmounting cancels everything still in flight.
 */
export function useRequestChannels(): RequestChannels {
  const controllersRef = useRef(new Map<RequestChannel, AbortController>());
  const channelsRef = useRef<RequestChannels | null>(null);

  useEffect(() => {
    const controllers = controllersRef.current;
    return () => {
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
    };
  }, []);

  if (!channelsRef.current) {
    channelsRef.current = {
      abort: (channel) => {
        controllersRef.current.get(channel)?.abort();
        controllersRef.current.delete(channel);
      },
      signalFor: (channel) => {
        controllersRef.current.get(channel)?.abort();
        const controller = new AbortController();
        controllersRef.current.set(channel, controller);
        return controller.signal;
      },
    };
  }
  return channelsRef.current;
}
