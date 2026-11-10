import { adaptiveConcurrencyFloor } from "../device/device.js";
import type { ResourceSignalSnapshot } from "./resource-signals.js";
import {
  conservativeTurnEstimate,
  type TurnUsageEstimate,
} from "./turn-usage-sampler.js";

export { adaptiveConcurrencyFloor };

export type AdmissionMode = "adaptive" | "forced";

export interface AdmissionSettings {
  forcedLimit?: number;
  mode: AdmissionMode;
}

export interface RunningTurnUsage {
  currentCpuCores: number;
  currentRssBytes: number;
  runtime: string;
  workspaceId: string;
}

export interface AdmissionPolicyState {
  cpuOffset?: number;
  highPressureSince?: number;
  limit?: number;
  pressureEwma?: number;
  recoverySince?: number;
  target?: number;
}

export interface AdmissionPolicyInput {
  estimates: readonly TurnUsageEstimate[];
  now: number;
  previous: AdmissionPolicyState;
  queued: number;
  running: readonly RunningTurnUsage[];
  settings: AdmissionSettings;
  signals: ResourceSignalSnapshot;
}

export interface AdmissionDecision {
  hardHold: boolean;
  limit: number;
  mode: AdmissionMode;
  reasons: string[];
  state: AdmissionPolicyState;
}

export const admissionThresholds = {
  cpuPressureHigh: 60,
  ewmaAlpha: 0.3,
  pressureSustainMs: 30_000,
} as const;

const mib = 1024 ** 2;
const maxLimit = 16;
const minimumParallelLimit = 4;

function boundedLimit(value: number): number {
  return Math.min(maxLimit, Math.max(1, Math.round(value)));
}

function ewma(previous: number | undefined, next: number): number {
  return previous === undefined
    ? next
    : previous + admissionThresholds.ewmaAlpha * (next - previous);
}

function requiredReserve(signals: ResourceSignalSnapshot): number {
  return Math.max(1024 * mib, (signals.memoryTotalBytes ?? 0) * 0.1);
}

function hardHoldThreshold(signals: ResourceSignalSnapshot): number {
  return Math.max(500 * mib, (signals.memoryTotalBytes ?? 0) * 0.03);
}

function memoryLimit(
  signals: ResourceSignalSnapshot,
  running: readonly RunningTurnUsage[],
  estimateTypical: number,
): number | undefined {
  if (signals.memoryAvailableBytes === undefined) return undefined;
  const currentRss = running.reduce(
    (sum, turn) => sum + turn.currentRssBytes,
    0,
  );
  const typical = Math.max(estimateTypical, 0);
  if (typical <= 0) return undefined;
  return Math.floor(
    (signals.memoryAvailableBytes +
      (signals.swapFreeBytes ?? 0) +
      currentRss -
      requiredReserve(signals)) /
      typical,
  );
}

function aggregateTypicalEstimate(
  estimates: readonly TurnUsageEstimate[],
): number | undefined {
  return estimates.length
    ? Math.max(...estimates.map((estimate) => estimate.typicalRssBytes))
    : undefined;
}

/** The parallel floor: small machines must not fall back to serial turns. */
/**
 * The admission decision for one sample. This is pure: all rolling state is
 * passed in and returned, so CPU recovery is table-testable. Memory picks
 * the target; CPU can only subtract from it temporarily.
 */
export function decideAdmission(
  input: AdmissionPolicyInput,
): AdmissionDecision {
  const memoryHeadroom =
    input.signals.memoryAvailableBytes !== undefined
      ? input.signals.memoryAvailableBytes + (input.signals.swapFreeBytes ?? 0)
      : undefined;
  const previousLimit = boundedLimit(input.previous.limit ?? 1);
  const hardHold =
    memoryHeadroom !== undefined &&
    memoryHeadroom < hardHoldThreshold(input.signals);
  if (input.settings.mode === "forced") {
    return {
      hardHold,
      limit: boundedLimit(input.settings.forcedLimit ?? previousLimit),
      mode: "forced",
      reasons: ["forced_mode", ...(hardHold ? ["memory_hard_hold"] : [])],
      state: {
        limit: boundedLimit(input.settings.forcedLimit ?? previousLimit),
      },
    };
  }

  const floor = adaptiveConcurrencyFloor(input.signals.cpuCount);
  const typicalEstimate =
    aggregateTypicalEstimate(input.estimates) ??
    conservativeTurnEstimate.typicalRssBytes;
  const memoryBounded = memoryLimit(
    input.signals,
    input.running,
    typicalEstimate,
  );
  const target = Math.max(floor, boundedLimit(memoryBounded ?? floor));
  const reasons: string[] = [
    memoryBounded !== undefined ? "memory_limit" : "parallel_floor",
    ...(input.estimates.length === 0 ? ["estimate_prior"] : []),
  ];
  let cpuOffset = Math.min(0, Math.round(input.previous.cpuOffset ?? 0));
  cpuOffset = Math.max(floor - target, cpuOffset);
  const pressure = input.signals.cpuPressurePercent;
  const pressureEwma =
    pressure === undefined
      ? input.previous.pressureEwma
      : ewma(input.previous.pressureEwma, pressure);
  let highPressureSince = input.previous.highPressureSince;
  let recoverySince = input.previous.recoverySince;

  if (
    pressureEwma !== undefined &&
    pressureEwma >= admissionThresholds.cpuPressureHigh
  ) {
    highPressureSince ??= input.now;
    recoverySince = undefined;
    reasons.push("cpu_pressure_high");
    if (
      input.now - highPressureSince >= admissionThresholds.pressureSustainMs &&
      cpuOffset > floor - target
    ) {
      cpuOffset -= 1;
      highPressureSince = input.now;
      reasons.push("cpu_limit_decreased");
    }
  } else if (pressureEwma !== undefined) {
    highPressureSince = undefined;
    recoverySince ??= input.now;
    reasons.push("cpu_pressure_recovering");
    if (
      cpuOffset < 0 &&
      input.now - recoverySince >= admissionThresholds.pressureSustainMs
    ) {
      cpuOffset += 1;
      recoverySince = input.now;
      reasons.push("cpu_limit_increased");
    }
  } else {
    highPressureSince = undefined;
    recoverySince = undefined;
  }

  const limit = Math.max(floor, boundedLimit(target + cpuOffset));
  if (limit === floor) reasons.push("parallel_floor");
  if (limit === maxLimit) reasons.push("maximum_limit");

  if (hardHold) reasons.push("memory_hard_hold");

  return {
    hardHold,
    limit,
    mode: "adaptive",
    reasons: [...new Set(reasons)],
    state: {
      cpuOffset,
      ...(highPressureSince !== undefined ? { highPressureSince } : {}),
      limit,
      ...(pressureEwma !== undefined ? { pressureEwma } : {}),
      ...(recoverySince !== undefined ? { recoverySince } : {}),
      target,
    },
  };
}
