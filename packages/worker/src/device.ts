/**
 * Device identity and runtime settings.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os, { hostname } from "node:os";
import { dirname } from "node:path";
import type {
  AgentRuntimeSettings,
  DeviceProjection,
  DeviceSystem,
} from "@bd777/foundry-protocol";
import { hardenPrivateFile, readJSONFile, writeJSON } from "./storage.js";
import { normalizeMaxConcurrentTasks } from "./task-scheduler.js";
import { foundryStatePath } from "./state-root.js";

export const devicePath = foundryStatePath("device.json");
export const runtimeSettingsPath = foundryStatePath(
  "runtime-settings.local.json",
);

/** The name people know the machine by; `.local` is mDNS noise on macOS. */
export function defaultDeviceLabel(): string {
  return (
    hostname().replace(/\.local$/, "") || `${process.platform}-${process.arch}`
  );
}

let cachedSystem: DeviceSystem | undefined;

function linuxRelease(): { os: string; osVersion?: string } {
  try {
    const fields = Object.fromEntries(
      readFileSync("/etc/os-release", "utf8")
        .split("\n")
        .map((line) => /^([A-Z_]+)=("?)(.*)\2$/.exec(line))
        .filter((match) => match !== null)
        .map((match) => [match[1], match[3]]),
    );
    return { os: fields.NAME || "Linux", osVersion: fields.VERSION };
  } catch {
    return { os: "Linux" };
  }
}

function macRelease(): { os: string; osVersion?: string } {
  const version = spawnSync("sw_vers", ["-productVersion"], {
    encoding: "utf8",
    timeout: 5000,
  }).stdout?.trim();
  return { os: "macOS", osVersion: version || undefined };
}

/** What machine this is, for people telling devices apart. */
export function deviceSystem(): DeviceSystem {
  if (cachedSystem) return cachedSystem;
  const cpus = os.cpus();
  let user: string | undefined;
  try {
    user = os.userInfo().username;
  } catch {
    user = undefined;
  }
  cachedSystem = {
    hostname: hostname(),
    ...(process.platform === "darwin"
      ? macRelease()
      : process.platform === "linux"
        ? linuxRelease()
        : { os: process.platform }),
    kernel: `${os.type()} ${os.release()}`,
    arch: process.arch,
    cpuModel: cpus[0]?.model.trim() || undefined,
    cpuCount: cpus.length || undefined,
    memoryBytes: os.totalmem(),
    user,
    nodeVersion: process.version,
  };
  return cachedSystem;
}

export function getDevice(): DeviceProjection {
  if (existsSync(devicePath)) {
    hardenPrivateFile(devicePath);
  }
  const stored = readJSONFile<DeviceProjection>(devicePath);
  const device: DeviceProjection = stored ?? {
    id: `dev_${randomUUID()}`,
    label: defaultDeviceLabel(),
    status: "connected",
    lastSeenLabel: "online",
  };
  device.runtimeSettings = readAgentRuntimeSettings();
  if (!stored) writeJSON(devicePath, device);
  return device;
}

/** The memory and CPUs the hardware default is computed from. */
export function deviceHardware(): { memoryBytes: number; cpus: number } {
  return {
    memoryBytes: os.totalmem(),
    cpus: os.availableParallelism?.() ?? os.cpus().length,
  };
}

/**
 * The turns a device runs at once when its owner has not chosen: one per
 * 4 GiB of memory and per 2 CPUs, whichever allows fewer, from 1 to 16
 * (DEV-084; a fixed 4 left large machines idle while turns waited, and
 * overloads a 2 GiB one).
 */
export function hardwareMaxConcurrentTasks(
  memoryBytes = deviceHardware().memoryBytes,
  cpus = deviceHardware().cpus,
): number {
  const byMemory = Math.floor(memoryBytes / (4 * 1024 ** 3));
  const byCpus = Math.floor(cpus / 2);
  return Math.min(16, Math.max(1, Math.min(byMemory, byCpus)));
}

export function defaultAgentRuntimeSettings(): AgentRuntimeSettings {
  return normalizeAgentRuntimeSettings({
    activeRuntimeTtlMs: Number(
      process.env.FOUNDRY_ACTIVE_RUNTIME_TTL_MS ?? 15 * 60 * 1000,
    ),
    // An administrator's environment counts as the owner's choice.
    maxConcurrentTasks: Number(process.env.FOUNDRY_MAX_CONCURRENT_TASKS ?? 0),
  });
}

export function readAgentRuntimeSettings(): AgentRuntimeSettings {
  if (process.env.FOUNDRY_EXECUTOR_SETTINGS)
    return normalizeAgentRuntimeSettings(
      JSON.parse(process.env.FOUNDRY_EXECUTOR_SETTINGS),
    );
  const defaults = defaultAgentRuntimeSettings();
  if (!existsSync(runtimeSettingsPath)) {
    return defaults;
  }
  hardenPrivateFile(runtimeSettingsPath);
  try {
    const parsed = JSON.parse(
      readFileSync(runtimeSettingsPath, "utf8"),
    ) as Partial<AgentRuntimeSettings>;
    const ttl = Number(parsed.activeRuntimeTtlMs);
    const maxConcurrentTasks = Number(parsed.maxConcurrentTasks);
    return normalizeAgentRuntimeSettings({
      activeRuntimeTtlMs:
        Number.isFinite(ttl) && ttl > 0 ? ttl : defaults.activeRuntimeTtlMs,
      maxConcurrentTasks:
        Number.isFinite(maxConcurrentTasks) && maxConcurrentTasks > 0
          ? maxConcurrentTasks
          : defaults.maxConcurrentTasksSource === "owner"
            ? defaults.maxConcurrentTasks
            : 0,
    });
  } catch {
    return defaults;
  }
}

/** The owner's settings; maxConcurrentTasks 0 returns to the hardware default. */
export function writeAgentRuntimeSettings(
  settings: AgentRuntimeSettings,
): AgentRuntimeSettings {
  const normalized = normalizeAgentRuntimeSettings(settings);
  mkdirSync(dirname(runtimeSettingsPath), { recursive: true });
  writeJSON(runtimeSettingsPath, {
    activeRuntimeTtlMs: normalized.activeRuntimeTtlMs,
    ...(normalized.maxConcurrentTasksSource === "owner"
      ? { maxConcurrentTasks: normalized.maxConcurrentTasks }
      : {}),
  });
  return readAgentRuntimeSettings();
}

/**
 * Settings within their bounds. A positive maxConcurrentTasks is the
 * owner's; none (0) or one marked as the hardware's is this device's
 * hardware default.
 */
export function normalizeAgentRuntimeSettings(
  settings: Partial<AgentRuntimeSettings>,
): AgentRuntimeSettings {
  const ttl = Number(settings.activeRuntimeTtlMs);
  const requested = Number(settings.maxConcurrentTasks);
  const machine = deviceHardware();
  const hardware = hardwareMaxConcurrentTasks(
    machine.memoryBytes,
    machine.cpus,
  );
  const owner =
    settings.maxConcurrentTasksSource !== "hardware" &&
    Number.isFinite(requested) &&
    requested > 0;
  return {
    activeRuntimeTtlMs: Math.min(
      24 * 60 * 60 * 1000,
      Math.max(
        60 * 1000,
        Number.isFinite(ttl) ? Math.round(ttl) : 15 * 60 * 1000,
      ),
    ),
    maxConcurrentTasks: owner
      ? normalizeMaxConcurrentTasks(requested)
      : hardware,
    maxConcurrentTasksSource: owner ? "owner" : "hardware",
    hardwareMaxConcurrentTasks: hardware,
    hardware: {
      memoryGiB: Math.round((machine.memoryBytes / 1024 ** 3) * 10) / 10,
      cpus: machine.cpus,
    },
  };
}
