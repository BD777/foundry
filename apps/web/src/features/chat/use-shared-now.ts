import { useSyncExternalStore } from "react";

/**
 * One clock for every live duration on the page: a single interval runs
 * while any component asks for it, so rows and panels tick together.
 */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let now = Date.now();

function tick(): void {
  now = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(tick, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const idle = () => () => undefined;
const snapshot = () => now;

/** Epoch ms, refreshed every second while `live`; otherwise it holds. */
export function useSharedNow(live: boolean): number {
  return useSyncExternalStore(live ? subscribe : idle, snapshot, snapshot);
}
