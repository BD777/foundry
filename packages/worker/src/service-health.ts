/**
 * How this device keeps the worker running, read without administrator
 * rights, so the Devices page can say why a device went away and how to
 * bring it back (DEV-088): the login service, whether systemd keeps it
 * running after the account logs out (linger), swap, and the worker's own
 * processes the kernel stopped for lack of memory.
 */
import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { DeviceServiceState } from "@bd777/foundry-protocol";
import {
  daemonLogDir,
  launchdPlistPath,
  serviceLabel,
  systemdUnitName,
  systemdUnitPath,
} from "./service.js";

const journalTtlMs = 10 * 60_000;
let journal:
  { until: number; value?: DeviceServiceState["oomKills"] } | undefined;
let journalRunning = false;

/** `~/…` for a path under the home folder, as people type it. */
function typed(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path;
}

/** Linger as `loginctl` reports it; undefined when it cannot be read. */
export function lingerEnabled(
  run: typeof spawnSync = spawnSync,
): boolean | undefined {
  const result = run(
    "loginctl",
    [
      "show-user",
      String(process.getuid?.() ?? ""),
      "--property=Linger",
      "--value",
    ],
    { encoding: "utf8", timeout: 3_000 },
  );
  const value = String(result.stdout ?? "").trim();
  if (result.status !== 0) return undefined;
  return value === "yes" ? true : value === "no" ? false : undefined;
}

/** SwapTotal from /proc/meminfo, in bytes (Linux only). */
export function swapBytes(meminfo = "/proc/meminfo"): number | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const kb = /^SwapTotal:\s+(\d+)\s+kB/m.exec(readFileSync(meminfo, "utf8"));
    return kb ? Number(kb[1]) * 1024 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The OOM kills systemd logged for the unit in the user journal: systemd
 * writes "A process of this unit has been killed by the OOM killer" and
 * "Failed with result 'oom-kill'" there, which the account itself may read.
 */
export function oomKillsFromJournal(
  output: string,
): DeviceServiceState["oomKills"] {
  const lines = output.split("\n");
  // One kill logs both lines; count the kill line, else the result line.
  const kills = lines.filter((line) => /killed by the OOM killer/i.test(line));
  const matched = kills.length
    ? kills
    : lines.filter((line) => /result 'oom-kill'/i.test(line));
  if (!matched.length) return undefined;
  const at = /^(\S+)/.exec(matched.at(-1) ?? "")?.[1];
  const lastAt =
    at && !Number.isNaN(Date.parse(at))
      ? new Date(at).toISOString()
      : undefined;
  return { count: matched.length, lastAt };
}

/** oom_kill in this process's own cgroup (the service's, under systemd). */
export function oomKillsFromCgroup(
  procCgroup = "/proc/self/cgroup",
  root = "/sys/fs/cgroup",
): number | undefined {
  try {
    const path = /^0::(\/.*)$/m.exec(readFileSync(procCgroup, "utf8"))?.[1];
    if (!path) return undefined;
    const events = readFileSync(`${root}${path}/memory.events`, "utf8");
    const value = /^oom_kill\s+(\d+)/m.exec(events)?.[1];
    return value === undefined ? undefined : Number(value);
  } catch {
    return undefined;
  }
}

function journalArgs(unit: string): string[] {
  return [
    "--user",
    "-u",
    unit,
    "--since",
    "-7d",
    "-o",
    "short-iso",
    "--no-pager",
    "-n",
    "5000",
  ];
}

/**
 * The first read waits (a few seconds at most), so the registration at
 * connect carries it: a restart after an OOM kill is when it matters. Later
 * reads run in the background and the next report carries them.
 */
function refreshJournal(unit: string): void {
  if (!journal) {
    const result = spawnSync("journalctl", journalArgs(unit), {
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    journal = {
      until: Date.now() + journalTtlMs,
      value:
        result.status === 0 ? oomKillsFromJournal(result.stdout) : undefined,
    };
    return;
  }
  if (journalRunning) return;
  journalRunning = true;
  execFile(
    "journalctl",
    journalArgs(unit),
    { encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout) => {
      journalRunning = false;
      journal = {
        until: Date.now() + journalTtlMs,
        value: error ? undefined : oomKillsFromJournal(stdout),
      };
    },
  );
}

/** The login service state this worker reports with its device. */
export function serviceState(): DeviceServiceState {
  const logDir = typed(daemonLogDir);
  if (process.platform === "linux") {
    const unit = systemdUnitName();
    const installed = existsSync(systemdUnitPath());
    if (!journal || journal.until < Date.now()) refreshJournal(unit);
    const cgroupKills = oomKillsFromCgroup();
    const journalKills = journal?.value;
    const oomKills =
      journalKills ?? (cgroupKills ? { count: cgroupKills } : undefined);
    return {
      manager: installed ? "systemd" : "none",
      unit,
      installed,
      linger: lingerEnabled(),
      logDir,
      ...(oomKills ? { oomKills } : {}),
    };
  }
  if (process.platform === "darwin") {
    const installed = existsSync(launchdPlistPath());
    return {
      manager: installed ? "launchd" : "none",
      unit: serviceLabel(),
      installed,
      logDir,
    };
  }
  return { manager: "none", installed: false, logDir };
}
