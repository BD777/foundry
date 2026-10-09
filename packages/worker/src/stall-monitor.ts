/**
 * Notices when the worker's event loop is blocked. A blocked loop cannot
 * answer the server's heartbeat; the server then drops the device. A one-second
 * timer measures how late it fires; a delay of several seconds is recorded with
 * the activities running at the time, and the next registration carries the
 * records to the server's log.
 */

import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import type { WorkerStall } from "@bd777/foundry-protocol";

export type { WorkerStall };

const tickMs = 1000;
/** A delay at least this long is a stall worth recording. */
export const stallThresholdMs = 5000;
const keptStalls = 10;

const active = new Map<string, number>();
const recent = new Set<string>();
let stalls: WorkerStall[] = [];
let history: WorkerStall[] = [];
let timer: ReturnType<typeof setInterval> | undefined;
let expected = 0;
let delays: IntervalHistogram | undefined;

/** A running maximum of tick delays, e.g. over one connection's life. */
export interface LagWindow {
  maxLagMs: number;
  close: () => void;
}
const windows = new Set<LagWindow>();

/** Starts tracking the worst delay until the window is closed. */
export function openLagWindow(): LagWindow {
  const window: LagWindow = {
    maxLagMs: 0,
    close: () => windows.delete(window),
  };
  windows.add(window);
  return window;
}

/** Event-loop delay since the monitor started, in milliseconds. */
export function eventLoopDelay():
  { p50: number; p99: number; max: number } | undefined {
  if (!delays || delays.count === 0) return undefined;
  const ms = (ns: number) => Math.round(ns / 1e6);
  return {
    p50: ms(delays.percentile(50)),
    p99: ms(delays.percentile(99)),
    max: ms(delays.max),
  };
}

/**
 * Marks a long-running activity until the returned function is called. The
 * label is also kept for the next tick, so an activity that blocked the loop
 * and finished before the timer could fire is still named.
 */
export function beginActivity(label: string): () => void {
  active.set(label, (active.get(label) ?? 0) + 1);
  recent.add(label);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const count = (active.get(label) ?? 1) - 1;
    if (count > 0) active.set(label, count);
    else active.delete(label);
  };
}

/** Runs an async activity with its marker. */
export async function duringActivity<T>(
  label: string,
  work: () => Promise<T>,
): Promise<T> {
  const end = beginActivity(label);
  try {
    return await work();
  } finally {
    end();
  }
}

/** Checks one tick: `now` against when it was due. */
export function recordTick(now: number): void {
  const lagMs = now - expected;
  if (expected && lagMs > 0)
    for (const window of windows)
      window.maxLagMs = Math.max(window.maxLagMs, Math.round(lagMs));
  if (expected && lagMs >= stallThresholdMs) {
    const activities = [...new Set([...active.keys(), ...recent])].sort();
    history = [
      ...history,
      { at: new Date(now).toISOString(), lagMs: Math.round(lagMs) },
    ].slice(-keptStalls);
    stalls = [
      ...stalls,
      {
        at: new Date(now).toISOString(),
        lagMs: Math.round(lagMs),
        ...(activities.length ? { activities } : {}),
      },
    ].slice(-keptStalls);
  }
  recent.clear();
  for (const label of active.keys()) recent.add(label);
  expected = now + tickMs;
}

export function startStallMonitor(): void {
  if (timer) return;
  delays = monitorEventLoopDelay({ resolution: 20 });
  delays.enable();
  expected = Date.now() + tickMs;
  timer = setInterval(() => recordTick(Date.now()), tickMs);
  timer.unref();
}

/** Recorded stalls, oldest first; taking them clears the record. */
export function takeStalls(): WorkerStall[] {
  const taken = stalls;
  stalls = [];
  return taken;
}

/** Puts back stalls that could not be delivered. */
export function restoreStalls(undelivered: WorkerStall[]): void {
  stalls = [...undelivered, ...stalls].slice(-keptStalls);
}

/**
 * A registration carrying the stalls recorded since the last one, so the
 * server's log shows why a device went quiet.
 */
export function withStalls<T extends object>(
  registration: T,
): T & { stalls?: WorkerStall[] } {
  const taken = takeStalls();
  return taken.length ? { ...registration, stalls: taken } : registration;
}

/** The last stalls, reported or not, for diagnostics. */
export function recentStalls(): WorkerStall[] {
  return [...history];
}
