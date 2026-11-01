import { serverFetch } from "./server-proxy.js";
/**
 * Device identity against the server: hashes of the machine, of the system
 * account the worker runs as and of this worker's own state (never the raw
 * ids or the user name), so each state root of each system account is one
 * device per Foundry account; the one-time pairing-token exchange that
 * yields this device's credential, asking the person first when another
 * person's device already uses the system account; and a lock so a state
 * root runs one daemon.
 */

import { execFileSync, spawnSync } from "node:child_process";
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
import { homedir, userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import {
  systemAccountSharedCode,
  type DeviceProjection,
  type DevicePairingConsentNeeded,
} from "@bd777/foundry-protocol";
import { devicePath, getDevice } from "./device.js";
import { foundryStatePath, foundryStateRoot } from "./state-root.js";
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

/** The OS machine id, or the random one kept in the state root. */
function machineId(): string {
  const machineId = osMachineId();
  if (machineId) return machineId;
  writePublicTextIfMissing(fallbackMachineIdPath, `${randomUUID()}\n`);
  return readFileSync(fallbackMachineIdPath, "utf8").trim();
}

/**
 * The system account the worker runs as: its numeric uid, or its SID on
 * Windows; never the user name.
 */
function systemAccountId(): string {
  if (process.platform === "win32") {
    try {
      const output = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], {
        encoding: "utf8",
      });
      const sid = /"(S-[0-9-]+)"/.exec(output)?.[1];
      if (sid) return sid;
    } catch {
      // Fall through to the uid Node reports (-1 on Windows).
    }
  }
  return String(process.getuid?.() ?? userInfo().uid);
}

/**
 * The account's own Foundry folder (`~/.foundry`), whichever state root
 * this worker uses: every worker under one system account shares its files
 * and sign-ins, so they count as one account.
 */
function accountStateRoot(): string {
  return resolve(homedir(), ".foundry");
}

function fingerprint(kind: string, ...parts: string[]): string {
  return createHash("sha256")
    .update(`foundry-${kind}:${parts.join("\0")}`)
    .digest("hex");
}

/** sha256 of the machine id alone: the computer, whoever uses it. */
export function hostFingerprint(): string {
  return fingerprint("host", machineId());
}

/**
 * sha256 of the machine id, the system account and the account's own
 * Foundry folder: one per system account of a computer. The server tells a
 * person who pairs under an account another person already uses that they
 * would share it.
 */
export function osAccountFingerprint(): string {
  return fingerprint(
    "os-account",
    machineId(),
    systemAccountId(),
    accountStateRoot(),
  );
}

/**
 * sha256 of the machine id, the system account and this worker's state
 * root: the device a new pairing becomes, so separate accounts, dev stacks
 * and state roots are separate devices.
 */
export function workerFingerprint(): string {
  return fingerprint(
    "worker",
    machineId(),
    systemAccountId(),
    foundryStateRoot(),
  );
}

let reportedIdentity:
  { osAccountFingerprint: string; hostFingerprint: string } | undefined;

/**
 * What a registration reports about where the worker runs, worked out once
 * per process (on macOS reading the machine id starts ioreg).
 */
export function deviceAccountIdentity(): {
  osAccountFingerprint: string;
  hostFingerprint: string;
} {
  reportedIdentity ??= {
    osAccountFingerprint: osAccountFingerprint(),
    hostFingerprint: hostFingerprint(),
  };
  return reportedIdentity;
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
 * The server refused the pairing because another person's device already
 * uses this system account; nothing was paired and the token is still good.
 * Pairing again with acceptSharedAccount, or after the person continued in
 * the web, shares the account.
 */
export class SharedAccountError extends Error {
  constructor(
    message: string,
    readonly sharedWith: string[],
  ) {
    super(message);
    this.name = "SharedAccountError";
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
  options: { acceptSharedAccount?: boolean } = {},
): Promise<{ deviceId: string; credential: string }> {
  const device = getDevice();
  const response = await serverFetch(`${serverURL}/api/daemon/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: token.trim(),
      deviceId: device.id,
      workerFingerprint: workerFingerprint(),
      ...deviceAccountIdentity(),
      ...(options.acceptSharedAccount ? { acceptSharedAccount: true } : {}),
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    const failure = parseFailure(text);
    if (
      response.status === 409 &&
      failure.code === systemAccountSharedCode &&
      Array.isArray(failure.sharedWith)
    )
      throw new SharedAccountError(
        failure.error ?? text.trim(),
        failure.sharedWith,
      );
    throw new PairingError((failure.error ?? text).trim(), response.status);
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

function parseFailure(text: string): Partial<DevicePairingConsentNeeded> {
  try {
    return JSON.parse(text) as Partial<DevicePairingConsentNeeded>;
  } catch {
    return {};
  }
}

const daemonLockPath = foundryStatePath("daemon.lock");

/**
 * Whether `pid` is a running Foundry daemon. The lock outlives a daemon that
 * crashed or a machine that rebooted, and its pid can by then belong to any
 * other process (or a zombie), so check what the process is, not only that
 * one exists.
 */
function isFoundryDaemon(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 5_000,
  });
  // Cannot tell (no ps): keep the lock rather than start a second daemon.
  if (ps.error || ps.status === null) return true;
  const command = ps.stdout.trim();
  return /(?:cli\.js|foundry-worker)\s+(?:daemon|connect)(?:\s|$)/.test(
    command,
  );
}

/** The running daemon that holds this state root's lock, if any. */
export function daemonLockHolder(): number | undefined {
  const holder = readLockPid();
  return holder && holder !== process.pid && isFoundryDaemon(holder)
    ? holder
    : undefined;
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
      const holder = daemonLockHolder();
      if (holder) {
        throw new Error(
          `another Foundry daemon is already running on this machine (pid ${holder})`,
        );
      }
      // Stale lock: its process is gone or is no longer a Foundry daemon.
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
