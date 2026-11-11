import type {
  AgentRuntimeSettings,
  DeviceRuntimeState,
} from "@bd777/foundry-protocol";
import { readAgentRuntimeSettings } from "../device/device.js";
import {
  agentProcessRegistry,
  readAgentProcessRecords,
} from "../platform/process/agent-processes.js";
import { foundryStatePath } from "../platform/state-root.js";
import type { ConcurrentTaskScheduler } from "../platform/task-scheduler.js";
import {
  decideAdmission,
  type AdmissionPolicyState,
} from "./admission-policy.js";
import {
  readResourceSignals,
  type ResourceSignalSnapshot,
} from "./resource-signals.js";
import {
  processGroupUsage,
  readProcessTable,
  TurnUsageSampler,
  type TurnUsageEstimate,
} from "./turn-usage-sampler.js";

export interface AdmissionControllerOptions {
  estimator?: TurnUsageSampler;
  readSettings?: () => AgentRuntimeSettings;
  readSignals?: () => ResourceSignalSnapshot;
  sampleIntervalMs?: number;
}

/**
 * Samples host and turn resource use and feeds the scheduler. It owns timers
 * and persistence; the decision itself stays in admission-policy.ts.
 */
export class AdaptiveConcurrencyController {
  private policy: AdmissionPolicyState;
  private readonly readSettings: () => AgentRuntimeSettings;
  private readonly readSignals: () => ResourceSignalSnapshot;
  private readonly sampleIntervalMs: number;
  private readonly sampler: TurnUsageSampler;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly scheduler: ConcurrentTaskScheduler,
    options: AdmissionControllerOptions = {},
  ) {
    this.readSettings = options.readSettings ?? readAgentRuntimeSettings;
    this.readSignals = options.readSignals ?? (() => readResourceSignals());
    this.sampleIntervalMs = options.sampleIntervalMs ?? 3000;
    this.sampler =
      options.estimator ??
      new TurnUsageSampler(foundryStatePath("turn-usage-estimates.json"));
    this.policy = { limit: scheduler.load().limit };
  }

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.sampleIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.sampler.save(true);
  }

  /** Applies a settings change now, without waiting for the next sample. */
  settingsChanged(): void {
    this.tick();
  }

  /** Samples once. Exposed for deterministic tests and immediate refresh. */
  tick(): DeviceRuntimeState {
    const settings = this.readSettings();
    const signals = this.readSignals();
    const runningContexts = this.scheduler.runningContexts();
    const measured =
      runningContexts.length > 0
        ? processGroupUsage(
            readAgentProcessRecords(agentProcessRegistry()),
            readProcessTable(),
          )
        : new Map();
    const activeSessionIds = new Set(
      runningContexts.flatMap((context) =>
        context.sessionId ? [context.sessionId] : [],
      ),
    );
    this.sampler.finishMissing(activeSessionIds);

    const running = runningContexts.flatMap((context) => {
      if (!context.sessionId || !context.workspaceId || !context.runtime)
        return [];
      const estimate = this.sampler.estimate(
        context.workspaceId,
        context.runtime,
      );
      const sample = measured.get(context.sessionId);
      const usage = {
        currentCpuCores: sample?.cpuCores ?? estimate.averageCpuCores,
        currentRssBytes: sample?.rssBytes ?? estimate.typicalRssBytes,
        runtime: context.runtime,
        sessionId: context.sessionId,
        workspaceId: context.workspaceId,
      };
      if (sample) this.sampler.observe(usage);
      return [usage];
    });
    const relevantEstimates = this.estimatesForContexts([
      ...runningContexts,
      ...this.scheduler.queuedContexts(),
    ]);
    const reportedEstimates = this.sampler.reportedEstimates(relevantEstimates);
    const load = this.scheduler.load();
    const decision = decideAdmission({
      estimates: relevantEstimates,
      now: Date.parse(signals.capturedAt) || Date.now(),
      previous: this.policy,
      queued: load.queued,
      running,
      settings: {
        mode: settings.mode ?? "adaptive",
        ...(settings.forcedLimit !== undefined
          ? { forcedLimit: settings.forcedLimit }
          : {}),
      },
      signals,
    });
    this.policy = decision.state;
    this.scheduler.configureAdmission({
      hardHold: decision.hardHold,
      limit: decision.limit,
      reasons: decision.reasons,
    });
    const applied = this.scheduler.load();
    this.sampler.save();

    const state: DeviceRuntimeState = {
      capturedAt: signals.capturedAt,
      estimates: reportedEstimates.map(contractEstimate),
      hardHold: decision.hardHold,
      limit: decision.limit,
      mode: decision.mode,
      queued: applied.queued,
      queuedExempt: applied.queuedExempt,
      queuedLimited: applied.queuedLimited,
      reasons: decision.reasons,
      running: applied.running,
      runningExempt: applied.runningExempt,
      runningLimited: applied.runningLimited,
      signals: {
        ...(signals.cpuCount !== undefined
          ? { cpuCount: signals.cpuCount }
          : {}),
        ...(signals.cpuPressurePercent !== undefined
          ? { cpuPressurePercent: signals.cpuPressurePercent }
          : {}),
        ...(signals.loadAverage1 !== undefined
          ? { loadAverage1: signals.loadAverage1 }
          : {}),
        ...(signals.memoryAvailableBytes !== undefined
          ? { memoryAvailableBytes: signals.memoryAvailableBytes }
          : {}),
        ...(signals.memoryPressurePercent !== undefined
          ? { memoryPressurePercent: signals.memoryPressurePercent }
          : {}),
        ...(signals.memoryTotalBytes !== undefined
          ? { memoryTotalBytes: signals.memoryTotalBytes }
          : {}),
        ...(signals.swapFreeBytes !== undefined
          ? { swapFreeBytes: signals.swapFreeBytes }
          : {}),
      },
    };
    this.scheduler.setRuntimeState(state);
    return state;
  }

  private estimatesForContexts(
    contexts: ReturnType<ConcurrentTaskScheduler["runningContexts"]>,
  ): TurnUsageEstimate[] {
    const estimates: TurnUsageEstimate[] = [];
    const seen = new Set<string>();
    for (const context of contexts) {
      if (!context.workspaceId || !context.runtime) continue;
      const key = `${context.workspaceId}\u001f${context.runtime}`;
      if (seen.has(key)) continue;
      seen.add(key);
      estimates.push(
        this.sampler.estimate(context.workspaceId, context.runtime),
      );
    }
    return estimates;
  }
}

function contractEstimate(estimate: TurnUsageEstimate) {
  return {
    averageCpuCores: estimate.averageCpuCores,
    peakRssBytes: estimate.peakRssBytes,
    source: estimate.source,
    typicalRssBytes: estimate.typicalRssBytes,
    ...(estimate.runtime ? { runtime: estimate.runtime } : {}),
    ...(estimate.workspaceId ? { workspaceId: estimate.workspaceId } : {}),
  };
}
