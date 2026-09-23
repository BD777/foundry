import type { AgentSession } from "@foundry/protocol";

const defaultRetryDelaysMs = [500, 1_500, 5_000, 10_000] as const;

export interface HydrateSessionThreadInput {
  load: (signal: AbortSignal) => Promise<AgentSession[]>;
  onLoaded: (sessions: AgentSession[]) => Promise<void> | void;
  retryDelaysMs?: readonly number[];
  signal: AbortSignal;
}

/**
 * Loads a persisted transcript until it succeeds or the selection is left.
 * SSE is an accelerator, not the source of truth, so a transient detail
 * failure must never strand a running session in its lightweight summary.
 */
export async function hydrateSessionThreadWithRetry({
  load,
  onLoaded,
  retryDelaysMs = defaultRetryDelaysMs,
  signal,
}: HydrateSessionThreadInput): Promise<void> {
  let attempt = 0;
  while (!signal.aborted) {
    try {
      const sessions = await load(signal);
      if (!signal.aborted && sessions.length > 0) {
        await onLoaded(sessions);
      }
      return;
    } catch {
      if (signal.aborted) {
        return;
      }
      const delay =
        retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] ?? 10_000;
      attempt += 1;
      await abortableDelay(delay, signal);
    }
  }
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = window.setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
