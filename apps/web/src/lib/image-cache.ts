import { useEffect, useState } from "react";
import { fetchImage } from "../api";
import { readResponseBlob, type ReadProgress } from "./read-response-blob";

/**
 * One load per image and variant per page. The inline view, the lightbox and
 * a reopened lightbox share what is already loaded; the original is read only
 * when something asks for it (the lightbox opening, a download).
 *
 * An entry is reference-counted: each user retains it, the object URL is
 * revoked a short while after the last release (so closing and reopening the
 * lightbox does not read the file again), and a read nobody waits for any
 * more is aborted.
 */
export type ImageVariant = "placeholder" | "preview" | "original";
export type ImageFailure =
  "offline" | "slow" | "missing" | "outside" | "removed" | "unavailable";

export type ImageSnapshot =
  | { phase: "idle" }
  | { phase: "loading"; progress: ReadProgress; retrying: boolean }
  | { phase: "ready"; url: string }
  | { phase: "error"; reason: ImageFailure };

type Entry = {
  key: string;
  source: string;
  variant: ImageVariant;
  snapshot: ImageSnapshot;
  refs: number;
  listeners: Set<() => void>;
  controller?: AbortController;
  dropTimer?: ReturnType<typeof setTimeout>;
  attempt: number;
};

/** How long an unused image stays loaded; a read in flight gets a moment. */
const keepMs = 30_000;
/**
 * A read nobody waits for is aborted after this, not at once: a view that
 * remounts (React strict mode, a list re-render) takes it over instead of
 * starting the same read again.
 */
const abandonMs = 250;
const entries = new Map<string, Entry>();

function failureReason(status: number): ImageFailure {
  if (status === 409) return "offline";
  if (status === 504) return "slow";
  if (status === 404) return "missing";
  if (status === 403) return "outside";
  if (status === 410) return "removed";
  return "unavailable";
}

function publish(entry: Entry, snapshot: ImageSnapshot): void {
  entry.snapshot = snapshot;
  for (const listener of [...entry.listeners]) listener();
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Reads the image: one automatic retry of a transient failure. */
async function load(entry: Entry, fresh: boolean): Promise<void> {
  const controller = new AbortController();
  entry.controller = controller;
  const { signal } = controller;
  const apiVariant = entry.variant === "original" ? undefined : entry.variant;
  for (let retry = 0; retry < 2; retry++) {
    let reason: ImageFailure = "unavailable";
    let transient = true;
    try {
      publish(entry, {
        phase: "loading",
        progress: { received: 0 },
        retrying: retry > 0,
      });
      const response = await fetchImage(entry.source, {
        variant: apiVariant,
        fresh: fresh || retry > 0,
        signal,
      });
      if (response.ok) {
        const blob = await readResponseBlob(response, signal, (progress) =>
          publish(entry, { phase: "loading", progress, retrying: retry > 0 }),
        );
        if (signal.aborted) return;
        publish(entry, { phase: "ready", url: URL.createObjectURL(blob) });
        return;
      }
      reason = failureReason(response.status);
      transient = response.status === 409 || response.status >= 500;
    } catch {
      if (signal.aborted) return;
    }
    if (signal.aborted) return;
    if (retry === 0 && transient) {
      publish(entry, {
        phase: "loading",
        progress: { received: 0 },
        retrying: true,
      });
      await wait(1000, signal);
      if (signal.aborted) return;
    } else {
      publish(entry, { phase: "error", reason });
      return;
    }
  }
}

function drop(entry: Entry): void {
  clearTimeout(entry.dropTimer);
  entry.controller?.abort();
  if (entry.snapshot.phase === "ready") URL.revokeObjectURL(entry.snapshot.url);
  entries.delete(entry.key);
}

export interface ImageHandle {
  snapshot(): ImageSnapshot;
  subscribe(listener: () => void): () => void;
  /**
   * Reads the image again, past the HTTP cache: after a failure, or (`force`)
   * when what arrived could not be shown.
   */
  retry(force?: boolean): void;
  release(): void;
}

/** Takes a reference on an image; the first one starts its read. */
export function retainImage(
  source: string,
  variant: ImageVariant,
): ImageHandle {
  const key = `${variant}\u0000${source}`;
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      key,
      source,
      variant,
      snapshot: { phase: "idle" },
      refs: 0,
      listeners: new Set(),
      attempt: 0,
    };
    entries.set(key, entry);
  }
  const held = entry;
  clearTimeout(held.dropTimer);
  held.refs += 1;
  // A failed image read again when it comes back into view (its device may
  // be back), as a fresh <img> would.
  const { phase } = held.snapshot;
  if (phase === "idle" || (phase === "error" && held.refs === 1)) {
    void load(held, false);
  }
  let released = false;
  return {
    snapshot: () => held.snapshot,
    subscribe(listener) {
      held.listeners.add(listener);
      return () => held.listeners.delete(listener);
    },
    retry(force = false) {
      const { phase } = held.snapshot;
      if (phase === "loading" || phase === "idle") return;
      if (phase === "ready") {
        if (!force) return;
        URL.revokeObjectURL(held.snapshot.url);
      }
      held.attempt += 1;
      void load(held, true);
    },
    release() {
      if (released) return;
      released = true;
      held.refs -= 1;
      if (held.refs > 0) return;
      // Nobody waits for a read in flight; a finished one is kept a while.
      held.dropTimer = setTimeout(
        () => {
          if (held.refs === 0) drop(held);
        },
        held.snapshot.phase === "loading" ? abandonMs : keepMs,
      );
    },
  };
}

/**
 * The image as a snapshot while this component holds it. `enabled: false`
 * holds nothing (the original before the lightbox opens).
 */
export function useCachedImage(
  source: string | undefined,
  variant: ImageVariant,
  enabled = true,
): ImageSnapshot & { retry: (force?: boolean) => void } {
  const [, rerender] = useState(0);
  const [handle, setHandle] = useState<ImageHandle>();
  useEffect(() => {
    if (!source || !enabled) {
      setHandle(undefined);
      return undefined;
    }
    const next = retainImage(source, variant);
    setHandle(next);
    const unsubscribe = next.subscribe(() => rerender((value) => value + 1));
    return () => {
      unsubscribe();
      next.release();
    };
  }, [source, variant, enabled]);
  const snapshot = handle?.snapshot() ?? { phase: "idle" as const };
  return { ...snapshot, retry: (force) => handle?.retry(force) };
}

/** Saves the original under `filename`, reading it first if need be. */
export async function downloadOriginal(
  source: string,
  filename: string,
): Promise<void> {
  const handle = retainImage(source, "original");
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const check = () => {
        const state = handle.snapshot();
        if (state.phase === "ready") resolve(state.url);
        else if (state.phase === "error")
          reject(new Error(`image ${state.reason}`));
        else return false;
        return true;
      };
      if (check()) return;
      const unsubscribe = handle.subscribe(() => {
        if (check()) unsubscribe();
      });
    });
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    handle.release();
  }
}

/** For tests. */
export function resetImageCache(): void {
  for (const entry of [...entries.values()]) drop(entry);
}
