/**
 * Device identity against the server: a hashed OS machine id so one machine
 * is one device per account, the one-time pairing-token exchange that yields
 * this device's credential, and a lock so a machine runs one daemon.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { DeviceProjection } from "@foundry/protocol";
import { devicePath, getDevice } from "./device.js";
import { foundryStackSuffix, foundryStatePath } from "./state-root.js";
import { writeJSON, writePublicTextIfMissing } from "./storage.js";

const fallbackMachineIdPath = foundryStatePath("machine-id.local");

/** The raw OS machine id, never sent to the server as is. */
function osMachineId(): string | undefined {
  if (process.platform === "darwin") {
    try {
      const output = execFileSync(
        "ioreg",
        ["-rd1", "-c", "IOPlatformExpertDevice"],
        { encoding: "utf8" },
      );
      return /"IOPlatformUUID" = "([^"]+)"/.exec(output)?.[1];
    } catch {
      return undefined;
    }
  }
  for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (value) return value;
    } catch {
      // Try the next location.
    }
  }
  return undefined;
}

/**
 * sha256 of the OS machine id (containers without one fall back to a random
 * id kept in the state root). Parallel dev stacks on one machine stay
 * distinct devices.
 */
export function machineFingerprint(): string {
  let machineId = osMachineId();
  if (!machineId) {
    writePublicTextIfMissing(fallbackMachineIdPath, `${randomUUID()}\n`);
    machineId = readFileSync(fallbackMachineIdPath, "utf8").trim();
  }
  return createHash("sha256")
    .update(`foundry-device:${machineId}${foundryStackSuffix()}`)
    .digest("hex");
}

export class PairingError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PairingError";
  }
}

/**
 * Redeems a one-time pairing token for this device's credential. The server
 * may assign a different device id (e.g. the machine was paired before); the
 * local identity follows it.
 */
export async function pairDevice(
  serverURL: string,
  token: string,
): Promise<{ deviceId: string; credential: string }> {
  const device = getDevice();
  const response = await fetch(`${serverURL}/api/daemon/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: token.trim(),
      machineFingerprint: machineFingerprint(),
      deviceId: device.id,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // Keep the raw body.
    }
    throw new PairingError(message.trim(), response.status);
  }
  const result = JSON.parse(text) as { deviceId: string; credential: string };
  if (result.deviceId !== device.id) {
    const { runtimeSettings: _, ...stored } = device;
    writeJSON(devicePath, {
      ...(stored as DeviceProjection),
      id: result.deviceId,
    });
  }
  return result;
}

const daemonLockPath = foundryStatePath("daemon.lock");

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Holds the daemon lock of this state root (one per machine outside dev
 * stacks) for the process lifetime. A second daemon exits instead of fighting
 * the first for the device's connection.
 */
export function acquireDaemonLock(): void {
  mkdirSync(dirname(daemonLockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(daemonLockPath, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      process.on("exit", () => {
        if (readLockPid() === process.pid)
          rmSync(daemonLockPath, { force: true });
      });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readLockPid();
      if (holder && holder !== process.pid && processAlive(holder)) {
        throw new Error(
          `another Foundry daemon is already running on this machine (pid ${holder})`,
        );
      }
      // Stale lock from a dead process.
      rmSync(daemonLockPath, { force: true });
    }
  }
  throw new Error(`could not acquire ${daemonLockPath}`);
}

function readLockPid(): number | undefined {
  if (!existsSync(daemonLockPath)) return undefined;
  const pid = Number(readFileSync(daemonLockPath, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}
