import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AgentProcessRecord } from "../platform/process/agent-processes.js";
import { writePrivateJSONAtomic } from "../platform/storage.js";
import { errorMessage } from "../platform/utils.js";

export const conservativeTurnEstimate = {
  averageCpuCores: 0.3,
  peakRssBytes: 1.5 * 1024 ** 3,
  typicalRssBytes: 400 * 1024 ** 2,
} as const;

export type TurnUsageEstimateSource = "observed" | "prior";

export interface TurnUsageEstimate {
  averageCpuCores: number;
  peakRssBytes: number;
  runtime?: string;
  source: TurnUsageEstimateSource;
  typicalRssBytes: number;
  workspaceId?: string;
}

export interface ActiveTurnUsage {
  currentCpuCores: number;
  currentRssBytes: number;
  runtime: string;
  sessionId: string;
  workspaceId: string;
}

export interface ProcessTableRow {
  cpuPercent: number;
  pgid: number;
  pid: number;
  rssKiB: number;
  state?: string;
}

export interface ProcessGroupUsage {
  cpuCores: number;
  processCount: number;
  rssBytes: number;
}

interface StoredEstimate {
  averageCpuCores: number;
  peakRssSamples: number[];
  samples: number;
  typicalRssBytes: number;
}

interface StoredSamplerState {
  estimates: Record<string, StoredEstimate>;
  version: 1;
}

interface ActivePeak {
  peakRssBytes: number;
  workspaceId: string;
  runtime: string;
}

const maxPeakSamples = 50;
const ewmaAlpha = 0.2;

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function keyFor(workspaceId: string, runtime: string): string {
  return `${workspaceId}\u001f${runtime}`;
}

function splitKey(key: string): { runtime: string; workspaceId: string } {
  const at = key.indexOf("\u001f");
  return at < 0
    ? { runtime: key, workspaceId: "" }
    : { runtime: key.slice(at + 1), workspaceId: key.slice(0, at) };
}

/** The conservative estimate used before this workspace has a sample. */
export function priorTurnEstimate(
  workspaceId?: string,
  runtime?: string,
): TurnUsageEstimate {
  return {
    ...conservativeTurnEstimate,
    source: "prior",
    ...(runtime ? { runtime } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };
}

/** 90th percentile by nearest rank; empty input has no value. */
export function percentile90(values: readonly number[]): number | undefined {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return undefined;
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.9) - 1)];
}

/** Parses `ps -axo pid=,pgid=,pcpu=,rss=,stat=` output. */
export function parseProcessTable(text: string): ProcessTableRow[] {
  return text.split("\n").flatMap((line) => {
    const [pid, pgid, cpuPercent, rssKiB, ...state] = line.trim().split(/\s+/);
    const row = {
      cpuPercent: Number(cpuPercent),
      pgid: Number(pgid),
      pid: Number(pid),
      rssKiB: Number(rssKiB),
      ...(state.length ? { state: state.join(" ") } : {}),
    };
    return Object.values(row).every(
      (value) => typeof value !== "number" || Number.isFinite(value),
    ) &&
      row.pid > 0 &&
      row.pgid > 0 &&
      row.cpuPercent >= 0 &&
      row.rssKiB >= 0
      ? [row]
      : [];
  });
}

/** Best-effort current process table; an unavailable one yields no rows. */
export function readProcessTable(): ProcessTableRow[] {
  try {
    const result = spawnSync("ps", ["-axo", "pid=,pgid=,pcpu=,rss=,stat="], {
      encoding: "utf8",
      timeout: 3000,
    });
    return result.status === 0 ? parseProcessTable(result.stdout) : [];
  } catch {
    return [];
  }
}

/**
 * Sums every non-zombie process in each recorded leader's process group and
 * attributes it to the turn recorded on that leader.
 */
export function processGroupUsage(
  records: readonly AgentProcessRecord[],
  rows: readonly ProcessTableRow[],
): Map<string, ProcessGroupUsage> {
  const bySession = new Map<string, ProcessGroupUsage>();
  for (const record of records) {
    const sessionId = record.context?.sessionId;
    if (!sessionId) continue;
    const members = rows.filter(
      (row) => row.pgid === record.pid && !row.state?.startsWith("Z"),
    );
    if (members.length === 0) continue;
    const current = bySession.get(sessionId) ?? {
      cpuCores: 0,
      processCount: 0,
      rssBytes: 0,
    };
    current.cpuCores +=
      members.reduce((sum, row) => sum + row.cpuPercent, 0) / 100;
    current.processCount += members.length;
    current.rssBytes +=
      members.reduce((sum, row) => sum + row.rssKiB, 0) * 1024;
    bySession.set(sessionId, current);
  }
  return bySession;
}

/** Persists rolling per-workspace/runtime estimates and per-turn peaks. */
export class TurnUsageSampler {
  private activePeaks = new Map<string, ActivePeak>();
  private dirty = false;
  private state: StoredSamplerState;

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {
    this.state = this.read();
  }

  observe(sample: ActiveTurnUsage): void {
    const key = keyFor(sample.workspaceId, sample.runtime);
    const current = this.state.estimates[key] ?? {
      averageCpuCores: conservativeTurnEstimate.averageCpuCores,
      peakRssSamples: [],
      samples: 0,
      typicalRssBytes: conservativeTurnEstimate.typicalRssBytes,
    };
    current.samples += 1;
    current.typicalRssBytes = ewma(
      current.typicalRssBytes,
      sample.currentRssBytes,
    );
    current.averageCpuCores = ewma(
      current.averageCpuCores,
      sample.currentCpuCores,
    );
    this.state.estimates[key] = current;
    const active = this.activePeaks.get(sample.sessionId) ?? {
      peakRssBytes: 0,
      runtime: sample.runtime,
      workspaceId: sample.workspaceId,
    };
    active.peakRssBytes = Math.max(active.peakRssBytes, sample.currentRssBytes);
    active.runtime = sample.runtime;
    active.workspaceId = sample.workspaceId;
    this.activePeaks.set(sample.sessionId, active);
    this.dirty = true;
  }

  /**
   * Ends turns no longer in the scheduler and records their peak RSS in the
   * rolling P90. Returns the sessions finished.
   */
  finishMissing(activeSessionIds: ReadonlySet<string>): string[] {
    const finished: string[] = [];
    for (const [sessionId, active] of this.activePeaks) {
      if (activeSessionIds.has(sessionId)) continue;
      const estimate =
        this.state.estimates[keyFor(active.workspaceId, active.runtime)];
      if (estimate && active.peakRssBytes > 0) {
        estimate.peakRssSamples.push(active.peakRssBytes);
        estimate.peakRssSamples =
          estimate.peakRssSamples.slice(-maxPeakSamples);
        this.dirty = true;
      }
      this.activePeaks.delete(sessionId);
      finished.push(sessionId);
    }
    return finished;
  }

  estimate(workspaceId: string, runtime: string): TurnUsageEstimate {
    const stored = this.state.estimates[keyFor(workspaceId, runtime)];
    return {
      averageCpuCores:
        stored?.averageCpuCores ?? conservativeTurnEstimate.averageCpuCores,
      peakRssBytes:
        percentile90(stored?.peakRssSamples ?? []) ??
        conservativeTurnEstimate.peakRssBytes,
      runtime,
      source: stored?.peakRssSamples.length ? "observed" : "prior",
      typicalRssBytes:
        stored?.typicalRssBytes ?? conservativeTurnEstimate.typicalRssBytes,
      workspaceId,
    };
  }

  estimates(): TurnUsageEstimate[] {
    return Object.keys(this.state.estimates)
      .sort()
      .map((key) => {
        const { runtime, workspaceId } = splitKey(key);
        return this.estimate(workspaceId, runtime);
      });
  }

  /** Reported observations plus active contexts; idle devices report a prior. */
  reportedEstimates(
    relevant: readonly TurnUsageEstimate[],
  ): TurnUsageEstimate[] {
    const estimates = this.estimates();
    const seen = new Set(
      estimates.map(
        (estimate) => `${estimate.workspaceId}\u001f${estimate.runtime}`,
      ),
    );
    for (const estimate of relevant) {
      const key = `${estimate.workspaceId}\u001f${estimate.runtime}`;
      if (seen.has(key)) continue;
      seen.add(key);
      estimates.push(estimate);
    }
    return estimates.length ? estimates : [priorTurnEstimate()];
  }

  /** Writes estimates when changed; no-op when the state is unchanged. */
  save(force = false): void {
    if (!force && !this.dirty) return;
    try {
      writePrivateJSONAtomic(this.path, this.state);
      this.dirty = false;
    } catch (error) {
      console.error(
        `Could not persist turn usage estimates: ${errorMessage(error)}`,
      );
    }
  }

  private read(): StoredSamplerState {
    try {
      const parsed = JSON.parse(
        readFileSync(this.path, "utf8"),
      ) as Partial<StoredSamplerState>;
      const estimates: Record<string, StoredEstimate> = {};
      for (const [key, value] of Object.entries(parsed.estimates ?? {})) {
        if (!value || typeof value !== "object") continue;
        const stored = value as Partial<StoredEstimate>;
        estimates[key] = {
          averageCpuCores:
            finiteNonNegative(stored.averageCpuCores) ??
            conservativeTurnEstimate.averageCpuCores,
          peakRssSamples: Array.isArray(stored.peakRssSamples)
            ? stored.peakRssSamples
                .map(finiteNonNegative)
                .filter((item): item is number => item !== undefined)
                .slice(-maxPeakSamples)
            : [],
          samples: finiteNonNegative(stored.samples) ?? 0,
          typicalRssBytes:
            finiteNonNegative(stored.typicalRssBytes) ??
            conservativeTurnEstimate.typicalRssBytes,
        };
      }
      return { estimates, version: 1 };
    } catch {
      return { estimates: {}, version: 1 };
    }
  }
}

function ewma(previous: number, next: number): number {
  return previous + ewmaAlpha * (next - previous);
}
