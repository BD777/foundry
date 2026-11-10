import { spawnSync } from "node:child_process";
import { availableParallelism, loadavg, totalmem } from "node:os";
import { readFileSync } from "node:fs";

/** One sample of the host pressure signals admission uses. */
export interface ResourceSignalSnapshot {
  capturedAt: string;
  cpuCount?: number;
  cpuPressurePercent?: number;
  loadAverage1?: number;
  memoryAvailableBytes?: number;
  memoryPressurePercent?: number;
  memoryTotalBytes?: number;
  swapFreeBytes?: number;
}

export interface ResourceSignalReadOptions {
  cpuCount?: number;
  loadAverage?: () => number[];
  now?: () => number;
  platform?: NodeJS.Platform;
  readText?: (path: string) => string | undefined;
  run?: (command: string, args: string[]) => string | undefined;
  totalMemoryBytes?: number;
}

interface PressureStats {
  fullAvg10?: number;
  someAvg10?: number;
}

const percent = (value: number): number => Math.min(100, Math.max(0, value));

function finitePercent(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? percent(parsed) : undefined;
}

/** MemAvailable from Linux's /proc/meminfo, in bytes. */
export function parseMemAvailable(text: string): number | undefined {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text);
  return match ? Number(match[1]) * 1024 : undefined;
}

/** SwapFree from Linux's /proc/meminfo, in bytes. */
export function parseSwapFree(text: string): number | undefined {
  const match = /^SwapFree:\s+(\d+)\s+kB$/m.exec(text);
  return match ? Number(match[1]) * 1024 : undefined;
}

/** PSI's avg10 values; a file can carry only `some`, or both lines. */
export function parsePressure(text: string): PressureStats {
  const parseLine = (name: "some" | "full") => {
    const match = new RegExp(`^${name}\\s+avg10=(\\S+)`, "m").exec(text);
    return finitePercent(match?.[1]);
  };
  return {
    ...(parseLine("full") !== undefined
      ? { fullAvg10: parseLine("full") }
      : {}),
    ...(parseLine("some") !== undefined
      ? { someAvg10: parseLine("some") }
      : {}),
  };
}

/**
 * macOS vm_stat's free-ish pages. Foundry treats free, inactive and
 * speculative pages as available: they can be reused without swapping.
 */
export function parseVmStatAvailable(text: string): {
  availableBytes?: number;
  pageSize?: number;
} {
  const pageSize = Number(
    /page size of\s+(\d+)\s+bytes/i.exec(text)?.[1] ?? NaN,
  );
  if (!Number.isFinite(pageSize) || pageSize <= 0) return {};
  const pages = (name: string) => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\.`, "m").exec(text);
    return match ? Number(match[1]) : 0;
  };
  return {
    availableBytes:
      (pages("Pages free") +
        pages("Pages inactive") +
        pages("Pages speculative")) *
      pageSize,
    pageSize,
  };
}

/** Free swap from macOS `vm.swapusage`, in bytes. */
export function parseVmSwapFree(text: string): number | undefined {
  const match = /free\s*=\s*([0-9.]+)([KMG])/i.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2]?.toUpperCase();
  if (!Number.isFinite(value) || value < 0 || !unit) return undefined;
  const multiplier = unit === "G" ? 1024 ** 3 : unit === "M" ? 1024 ** 2 : 1024;
  return Math.round(value * multiplier);
}

function normalizedLoadPressure(
  loadAverage1: number | undefined,
  cpuCount: number | undefined,
): number | undefined {
  if (
    loadAverage1 === undefined ||
    !Number.isFinite(loadAverage1) ||
    !cpuCount ||
    cpuCount <= 0
  )
    return undefined;
  return percent((loadAverage1 / cpuCount) * 100);
}

/**
 * Reads one best-effort signal sample. Missing files, commands and values
 * become undefined; this runs beside turns and must never fail them.
 */
export function readResourceSignals(
  options: ResourceSignalReadOptions = {},
): ResourceSignalSnapshot {
  const now = options.now ?? Date.now;
  const platform = options.platform ?? process.platform;
  const cpuCount =
    options.cpuCount ??
    (Number.isFinite(availableParallelism()) ? availableParallelism() : 1);
  const memoryTotalBytes = options.totalMemoryBytes ?? totalmem();
  const loadAverages = options.loadAverage?.() ?? loadavg();
  const loadAverage1 =
    platform !== "win32" && Number.isFinite(loadAverages[0])
      ? loadAverages[0]
      : undefined;
  const readText =
    options.readText ??
    ((path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    });
  const run =
    options.run ??
    ((command: string, args: string[]) => {
      try {
        const result = spawnSync(command, args, {
          encoding: "utf8",
          timeout: 2000,
        });
        return result.status === 0 ? result.stdout : undefined;
      } catch {
        return undefined;
      }
    });

  let memoryAvailableBytes: number | undefined;
  let memoryPressurePercent: number | undefined;
  let swapFreeBytes: number | undefined;
  let cpuPressurePercent: number | undefined;

  if (platform === "linux") {
    const meminfo = readText("/proc/meminfo");
    if (meminfo) {
      memoryAvailableBytes = parseMemAvailable(meminfo);
      swapFreeBytes = parseSwapFree(meminfo);
    }
    const cpuPressure = readText("/proc/pressure/cpu");
    if (cpuPressure) cpuPressurePercent = parsePressure(cpuPressure).someAvg10;
    const memoryPressure = readText("/proc/pressure/memory");
    if (memoryPressure) {
      const parsed = parsePressure(memoryPressure);
      memoryPressurePercent = parsed.fullAvg10 ?? parsed.someAvg10;
    }
  } else if (platform === "darwin") {
    const vmStat = run("vm_stat", []);
    if (vmStat) {
      const parsed = parseVmStatAvailable(vmStat);
      memoryAvailableBytes = parsed.availableBytes;
      if (parsed.availableBytes !== undefined && memoryTotalBytes > 0)
        memoryPressurePercent = percent(
          100 - (parsed.availableBytes / memoryTotalBytes) * 100,
        );
    }
    const swapUsage = run("vm.swapusage", []);
    if (swapUsage) swapFreeBytes = parseVmSwapFree(swapUsage);
  }

  cpuPressurePercent ??= normalizedLoadPressure(loadAverage1, cpuCount);
  return {
    capturedAt: new Date(now()).toISOString(),
    ...(cpuCount > 0 ? { cpuCount } : {}),
    ...(cpuPressurePercent !== undefined ? { cpuPressurePercent } : {}),
    ...(loadAverage1 !== undefined ? { loadAverage1 } : {}),
    ...(memoryAvailableBytes !== undefined ? { memoryAvailableBytes } : {}),
    ...(memoryPressurePercent !== undefined ? { memoryPressurePercent } : {}),
    ...(memoryTotalBytes > 0 ? { memoryTotalBytes } : {}),
    ...(swapFreeBytes !== undefined ? { swapFreeBytes } : {}),
  };
}
