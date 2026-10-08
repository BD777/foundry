/**
 * One update at a time on a device: an update requested from the web holds
 * this lock until the update command finishes. A lock older than the window
 * is treated as left behind by an update that was killed.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { foundryStatePath } from "./state-root.js";

export const selfUpdateWindowMs = 15 * 60_000;

const lockPath = () => foundryStatePath("logs", "self-update.lock");

/** When the update in progress started, if one is. */
export function selfUpdateInProgress(now = Date.now()): string | undefined {
  try {
    const started = readFileSync(lockPath(), "utf8").trim();
    return now - Date.parse(started) < selfUpdateWindowMs ? started : undefined;
  } catch {
    return undefined;
  }
}

export function holdSelfUpdateLock(now = new Date()): void {
  mkdirSync(dirname(lockPath()), { recursive: true });
  writeFileSync(lockPath(), now.toISOString());
}

export function releaseSelfUpdateLock(): void {
  rmSync(lockPath(), { force: true });
}
