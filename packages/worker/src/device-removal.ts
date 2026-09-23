/**
 * Soft-removal state on the worker side.
 *
 * When the server removes a device it sends a permanent WebSocket close
 * (4001 / "device_removed") or answers HTTP registration with 410. The worker
 * records a marker and parks: no reconnect loop, no network traffic, no log
 * spam, and none of its local configuration is deleted. Recovery is an
 * explicit user action — running `foundry-worker pair/setup` clears the
 * marker and rotates the device identity so the machine re-registers cleanly.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hardenPrivateFile, writePrivateJSONAtomic } from "./storage.js";
import { foundryStatePath } from "./state-root.js";

export const deviceRemovedReason = "device_removed";
export const deviceRemovedCloseCode = 4001;

export interface DeviceRemovedMarker {
  serverUrl: string;
  deviceId: string;
  deviceLabel?: string;
  removedAt: string;
}

export function deviceRemovedMarkerPath(): string {
  return foundryStatePath("device-removed.json");
}

export function readDeviceRemovedMarker(): DeviceRemovedMarker | undefined {
  const path = deviceRemovedMarkerPath();
  if (!existsSync(path)) {
    return undefined;
  }
  hardenPrivateFile(path);
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf8"),
    ) as DeviceRemovedMarker;
    if (!parsed.serverUrl || !parsed.removedAt) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeDeviceRemovedMarker(marker: DeviceRemovedMarker): void {
  writePrivateJSONAtomic(deviceRemovedMarkerPath(), marker);
}

export function clearDeviceRemovedMarker(): void {
  try {
    rmSync(deviceRemovedMarkerPath(), { force: true });
  } catch {
    // Removing a state marker must never block pairing; a stale marker would
    // simply be overwritten on the next removal.
  }
}

interface DeviceRemovedSignalShape {
  code?: number;
  reason?: string;
  message?: string;
}

/**
 * Recognizes the server's permanent removal signal across transports:
 * a 4001 WebSocket close, the "device_removed" reason text, or the HTTP 410
 * error body that postJSON embeds in its thrown message.
 */
export function isDeviceRemovedSignal(
  input: string | DeviceRemovedSignalShape | undefined | null,
): boolean {
  if (!input) return false;
  if (typeof input === "string") {
    return input.includes(deviceRemovedReason);
  }
  if (input.code === deviceRemovedCloseCode) {
    return true;
  }
  return (
    (input.reason ?? "").includes(deviceRemovedReason) ||
    (input.message ?? "").includes(deviceRemovedReason)
  );
}

/**
 * Stable terminal state for a removed daemon: emit guidance once and stay
 * alive quietly. The heartbeat keeps being written so the watchdog never
 * decides the process is stuck and kills it, and launchd therefore never
 * restart-loops it; there is no outbound traffic. The promise settles when a
 * service stop signal arrives or the (test-only) abort signal fires. An
 * explicit `pair`/`setup` after the process restarts is the only way back to
 * registration.
 */
export async function parkAfterDeviceRemoval(
  marker: DeviceRemovedMarker,
  options: { signal?: AbortSignal; heartbeatMs?: number } = {},
): Promise<void> {
  console.warn(
    `This device${marker.deviceLabel ? ` (${marker.deviceLabel})` : ""} was removed from ${marker.serverUrl}. ` +
      "Foundry has stopped syncing it. Local files, sign-ins and settings were kept. " +
      'Run "foundry-worker setup" or "foundry-worker pair" on this machine to register it again.',
  );
  const heartbeatPath = foundryStatePath("daemon-heartbeat");
  const touchHeartbeat = (): void => {
    try {
      writeFileSync(heartbeatPath, new Date().toISOString());
    } catch {
      // Best effort; the watchdog only kills a genuinely stuck process.
    }
  };
  touchHeartbeat();
  const heartbeat = setInterval(touchHeartbeat, options.heartbeatMs ?? 30_000);
  try {
    await new Promise<void>((resolve) => {
      const stopSignals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
      const finish = (): void => {
        for (const signal of stopSignals)
          process.removeListener(signal, finish);
        options.signal?.removeEventListener("abort", finish);
        resolve();
      };
      for (const signal of stopSignals) process.once(signal, finish);
      options.signal?.addEventListener("abort", finish, { once: true });
    });
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * prepareExplicitRepair is the boundary between automatic reconnects and a
 * user-driven re-pair. It is called only by the `pair`/`setup` commands.
 * Returns true when a removed marker was present; the caller must then rotate
 * device.json so the machine registers under a new device identity.
 */
export function prepareExplicitRepair(): boolean {
  const marker = readDeviceRemovedMarker();
  if (!marker) {
    return false;
  }
  clearDeviceRemovedMarker();
  return true;
}
