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
import { hardenPrivateFile, writeJSON } from "./storage.js";
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
  const stored = existsSync(devicePath)
    ? (JSON.parse(readFileSync(devicePath, "utf8")) as DeviceProjection)
    : undefined;
  const device: DeviceProjection = stored ?? {
    id: `dev_${randomUUID()}`,
    label: defaultDeviceLabel(),
    status: "connected",
    lastSeenLabel: "online",
  };
  // Devices paired before 0.5.4 were all named after their platform
  // ("linux-x64"), which cannot tell two machines apart.
  const legacyLabel = stored?.label === `${process.platform}-${process.arch}`;
  if (legacyLabel) device.label = defaultDeviceLabel();
  device.runtimeSettings = readAgentRuntimeSettings();
  if (!stored || legacyLabel) writeJSON(devicePath, device);
  return device;
}

export function defaultAgentRuntimeSettings(): AgentRuntimeSettings {
  return {
    activeRuntimeTtlMs: Number(
      process.env.FOUNDRY_ACTIVE_RUNTIME_TTL_MS ?? 15 * 60 * 1000,
    ),
    maxConcurrentTasks: normalizeMaxConcurrentTasks(
      Number(process.env.FOUNDRY_MAX_CONCURRENT_TASKS ?? 4),
    ),
  };
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
    return {
      activeRuntimeTtlMs:
        Number.isFinite(ttl) && ttl > 0
          ? Math.round(ttl)
          : defaults.activeRuntimeTtlMs,
      maxConcurrentTasks:
        Number.isFinite(maxConcurrentTasks) && maxConcurrentTasks > 0
          ? normalizeMaxConcurrentTasks(maxConcurrentTasks)
          : defaults.maxConcurrentTasks,
    };
  } catch {
    return defaults;
  }
}

export function writeAgentRuntimeSettings(
  settings: AgentRuntimeSettings,
): AgentRuntimeSettings {
  const normalized = normalizeAgentRuntimeSettings(settings);
  mkdirSync(dirname(runtimeSettingsPath), { recursive: true });
  writeJSON(runtimeSettingsPath, normalized);
  return normalized;
}

export function normalizeAgentRuntimeSettings(
  settings: AgentRuntimeSettings,
): AgentRuntimeSettings {
  const ttl = Number(settings.activeRuntimeTtlMs);
  const maxConcurrentTasks = Number(settings.maxConcurrentTasks);
  return {
    activeRuntimeTtlMs: Math.min(
      24 * 60 * 60 * 1000,
      Math.max(
        60 * 1000,
        Number.isFinite(ttl) ? Math.round(ttl) : 15 * 60 * 1000,
      ),
    ),
    maxConcurrentTasks: normalizeMaxConcurrentTasks(maxConcurrentTasks),
  };
}
