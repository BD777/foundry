// The scanner runs the detectors and reports the device's inventory: all of
// them when a server that takes reports is attached (connect) and on demand
// (rescan), then each on its own interval. A detector's failure stays its
// own (an error in the report; the server keeps what it found before, as
// stale). A report goes out only when the inventory changed, or after
// attach, so the server always starts from a whole snapshot.

import type {
  DetectedResource,
  ResourceBackend,
  ResourceDetectorError,
  ResourceReadiness,
  ResourcesReport,
} from "@bd777/foundry-protocol";
import {
  detectorName,
  runDetector,
  type Detector,
  type DetectorOutcome,
} from "./detector.js";
import { builtinDetectors } from "./detectors/index.js";

/** The scanner's rules and detector set; raised when they change. */
export const scannerVersion = 1;

export interface ScannerOptions {
  detectors?: readonly Detector[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface ScannerAttachment {
  /** Sends a report; false when it could not go (it is sent again later). */
  send(report: ResourcesReport): boolean;
  /** Folders of the workspaces served now. */
  workspacePaths?: () => string[];
}

const readinessLevels = ["installed", "configured", "permitted", "verified"];

export class ResourceScanner {
  private readonly detectors: readonly Detector[];
  private readonly outcomes = new Map<string, DetectorOutcome>();
  private readonly running = new Map<string, Promise<void>>();
  private timers: NodeJS.Timeout[] = [];
  private attachment: ScannerAttachment | undefined;
  /** The last report sent, without its time. */
  private sent: string | undefined;
  /** Whether a whole scan finished since attach. */
  private scanned = false;

  constructor(private readonly options: ScannerOptions = {}) {
    const platform = options.platform ?? process.platform;
    this.detectors = (options.detectors ?? builtinDetectors).filter(
      (detector) => detector.platforms.includes(platform),
    );
  }

  /**
   * Reports through attachment from now on: a whole scan at once, then
   * each detector on its interval, until detach.
   */
  attach(attachment: ScannerAttachment): void {
    this.detach();
    this.attachment = attachment;
    this.sent = undefined;
    this.scanned = false;
    void this.scanAll();
    for (const detector of this.detectors) {
      const timer = setInterval(
        () => void this.scan(detector).then(() => this.flush()),
        detector.intervalMs,
      );
      timer.unref();
      this.timers.push(timer);
    }
  }

  detach(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.attachment = undefined;
  }

  /** Runs every detector now and reports the result when attached. */
  async scanAll(): Promise<ResourcesReport> {
    await Promise.all(this.detectors.map((detector) => this.scan(detector)));
    this.scanned = true;
    this.flush();
    return this.report();
  }

  /**
   * Runs one detector now (by id) and reports when the inventory changed;
   * the rest keep what they last found.
   */
  async scanOne(detectorId: string): Promise<void> {
    const detector = this.detectors.find((item) => item.id === detectorId);
    if (!detector) return;
    await this.scan(detector);
    this.flush();
  }

  /** The inventory as the detectors last found it. */
  report(): ResourcesReport {
    const byKey = new Map<string, DetectedResource>();
    const detectorErrors: ResourceDetectorError[] = [];
    for (const detector of this.detectors) {
      const outcome = this.outcomes.get(detector.id);
      if (!outcome) continue;
      if (outcome.error !== undefined)
        detectorErrors.push({
          detector: detectorName(detector),
          type: detector.type,
          error: outcome.error,
        });
      for (const instance of outcome.instances) {
        const known = byKey.get(instance.key);
        byKey.set(instance.key, known ? merge(known, instance) : instance);
      }
    }
    return {
      scannerVersion,
      scannedAt: (this.options.now?.() ?? new Date()).toISOString(),
      instances: [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)),
      detectorErrors,
    };
  }

  /** Runs one detector, or waits for its run already under way. */
  private scan(detector: Detector): Promise<void> {
    const under = this.running.get(detector.id);
    if (under) return under;
    const run = runDetector(detector, {
      platform: this.options.platform,
      env: this.options.env,
      workspacePaths: () => this.attachment?.workspacePaths?.() ?? [],
    })
      .then((outcome) => {
        if (outcome.error !== undefined)
          console.warn(
            `Resource detector ${detectorName(detector)} failed: ${outcome.error}`,
          );
        this.outcomes.set(detector.id, outcome);
      })
      .finally(() => this.running.delete(detector.id));
    this.running.set(detector.id, run);
    return run;
  }

  /** Sends the inventory when attached, scanned and changed. */
  private flush(): void {
    if (!this.attachment || !this.scanned) return;
    const report = this.report();
    const body = JSON.stringify({ ...report, scannedAt: undefined });
    if (body === this.sent) return;
    if (this.attachment.send(report)) this.sent = body;
  }
}

/**
 * Two detectors' views of one instance (one desktop, two backends): its
 * backends together, ready when either is, at the higher level.
 */
/** Whether Foundry operates it remotely (a remote_ops backend, e.g. cua-driver). */
function operatedRemotely(resource: DetectedResource): boolean {
  return (resource.backends ?? []).some(
    (backend) => backend.mode === "remote_ops",
  );
}

/**
 * One instance found by two detectors. When only one of them operates it
 * remotely, that one leads: its readiness is the instance's (leases go
 * through it), its backend is listed first and its details win; the other
 * (e.g. the worker's own grants, for sessions on the device) stays a
 * secondary backend.
 */
function merge(
  first: DetectedResource,
  second: DetectedResource,
): DetectedResource {
  const leading = operatedRemotely(second) && !operatedRemotely(first);
  const [left, right] = leading ? [second, first] : [first, second];
  const backends = new Map<string, ResourceBackend>();
  for (const backend of [...(left.backends ?? []), ...(right.backends ?? [])])
    if (!backends.has(backend.id)) backends.set(backend.id, backend);
  const remoteLeads = operatedRemotely(left) && !operatedRemotely(right);
  return {
    ...left,
    readiness: remoteLeads
      ? left.readiness
      : mergeReadiness(left.readiness, right.readiness),
    ...(backends.size ? { backends: [...backends.values()] } : {}),
    ...(remoteLeads
      ? left.details
        ? { details: left.details }
        : {}
      : left.details || right.details
        ? { details: { ...right.details, ...left.details } }
        : {}),
  };
}

function mergeReadiness(
  left: ResourceReadiness,
  right: ResourceReadiness,
): ResourceReadiness {
  const level =
    readinessLevels.indexOf(left.level) >= readinessLevels.indexOf(right.level)
      ? left.level
      : right.level;
  if (left.ready || right.ready) return { ready: true, level };
  const missing = [
    ...new Set([...(left.missing ?? []), ...(right.missing ?? [])]),
  ];
  return {
    ready: false,
    level,
    ...((left.reason ?? right.reason)
      ? { reason: left.reason ?? right.reason }
      : {}),
    ...(missing.length ? { missing } : {}),
  };
}
