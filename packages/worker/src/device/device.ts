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
import {
  hardenPrivateFile,
  readJSONFile,
  writeJSON,
} from "../platform/storage.js";
import { normalizeMaxConcurrentTasks } from "../platform/task-scheduler.js";
import { foundryStatePath } from "../platform/state-root.js";

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

/** The memory and CPUs shown beside the adaptive concurrency floor. */
export function deviceHardware(): { memoryBytes: number; cpus: number } {
  return {
    memoryBytes: os.totalmem(),
    cpus: os.availableParallelism?.() ?? os.cpus().length,
  };
}

export function defaultAgentRuntimeSettings(): AgentRuntimeSettings {
  const forcedLimit = Number(process.env.FOUNDRY_MAX_CONCURRENT_TASKS ?? 0);
  return normalizeAgentRuntimeSettings({
    activeRuntimeTtlMs: Number(
      process.env.FOUNDRY_ACTIVE_RUNTIME_TTL_MS ?? 15 * 60 * 1000,
    ),
    mode: forcedLimit > 0 ? "forced" : "adaptive",
    ...(forcedLimit > 0 ? { forcedLimit } : {}),
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
    const normalized = normalizeAgentRuntimeSettings({
      ...parsed,
      activeRuntimeTtlMs:
        Number.isFinite(ttl) && ttl > 0 ? ttl : defaults.activeRuntimeTtlMs,
    });
    if (parsed.mode === undefined && parsed.maxConcurrentTasks !== undefined)
      writeJSON(runtimeSettingsPath, storedRuntimeSettings(normalized));
    return normalized;
  } catch {
    return defaults;
  }
}

/** Writes the new shape plus the legacy limit older hosts still read. */
export function writeAgentRuntimeSettings(
  settings: AgentRuntimeSettings,
): AgentRuntimeSettings {
  const normalized = normalizeAgentRuntimeSettings(settings);
  mkdirSync(dirname(runtimeSettingsPath), { recursive: true });
  writeJSON(runtimeSettingsPath, storedRuntimeSettings(normalized));
  return readAgentRuntimeSettings();
}

function storedRuntimeSettings(settings: AgentRuntimeSettings) {
  const legacyLimit =
    settings.mode === "forced"
      ? (settings.forcedLimit ??
        normalizeMaxConcurrentTasks(settings.maxConcurrentTasks ?? 0))
      : adaptiveConcurrencyFloor(settings.hardware?.cpus);
  return {
    activeRuntimeTtlMs: settings.activeRuntimeTtlMs,
    mode: settings.mode,
    ...(settings.forcedLimit !== undefined
      ? { forcedLimit: settings.forcedLimit }
      : {}),
    ...(settings.migrationNotice
      ? { migrationNotice: settings.migrationNotice }
      : {}),
    maxConcurrentTasks: legacyLimit,
    maxConcurrentTasksSource: settings.mode === "forced" ? "owner" : "hardware",
  };
}

/**
 * Settings within their bounds. Explicit older maxConcurrentTasks values
 * stay fixed, hardware-derived legacy values become adaptive, and the
 * environment override remains an explicit forced limit.
 */
export function normalizeAgentRuntimeSettings(
  settings: Partial<AgentRuntimeSettings>,
): AgentRuntimeSettings {
  const ttl = Number(settings.activeRuntimeTtlMs);
  const legacyLimit = Number(settings.maxConcurrentTasks);
  const environmentLimit = Number(
    process.env.FOUNDRY_MAX_CONCURRENT_TASKS ?? 0,
  );
  const environmentForced =
    Number.isFinite(environmentLimit) && environmentLimit > 0;
  const machine = deviceHardware();
  const floor = adaptiveConcurrencyFloor(machine.cpus);
  const legacyFixed =
    settings.mode === undefined &&
    Number.isFinite(legacyLimit) &&
    legacyLimit > 0 &&
    settings.maxConcurrentTasksSource !== "hardware";
  const mode =
    environmentForced || settings.mode === "forced" || legacyFixed
      ? "forced"
      : "adaptive";
  const forcedLimit = normalizeMaxConcurrentTasks(
    environmentForced
      ? environmentLimit
      : mode === "forced"
        ? Number(settings.forcedLimit ?? (legacyFixed ? legacyLimit : floor))
        : floor,
  );
  return {
    activeRuntimeTtlMs: Math.min(
      24 * 60 * 60 * 1000,
      Math.max(
        60 * 1000,
        Number.isFinite(ttl) ? Math.round(ttl) : 15 * 60 * 1000,
      ),
    ),
    mode,
    ...(mode === "forced" ? { forcedLimit } : {}),
    // Kept for older clients and workers while the UI moves to mode.
    maxConcurrentTasks: mode === "forced" ? forcedLimit : floor,
    maxConcurrentTasksSource: mode === "forced" ? "owner" : "hardware",
    ...(settings.migrationNotice
      ? { migrationNotice: settings.migrationNotice }
      : {}),
    hardwareMaxConcurrentTasks: floor,
    hardware: {
      memoryGiB: Math.round((machine.memoryBytes / 1024 ** 3) * 10) / 10,
      cpus: machine.cpus,
    },
  };
}

/**
 * The adaptive concurrency floor: never fewer than 4 turns, or two per core,
 * capped at 16. Resource signals only trim above it.
 */
export function adaptiveConcurrencyFloor(cpuCount: number | undefined): number {
  return cpuCount && Number.isFinite(cpuCount) && cpuCount > 0
    ? Math.min(16, Math.max(4, Math.round(cpuCount * 2)))
    : 4;
}
