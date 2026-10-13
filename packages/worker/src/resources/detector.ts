// The detector interface of the resources module. A detector finds the
// instances of one resource type on this device: cheaply (file checks,
// local config, `--version`-style commands), passively (never prompts,
// never touches the screen, never makes a network call, never reads a
// secret's value) and within its time limit. The scanner (scanner.ts) runs
// detectors on their own schedules, isolates their failures and reports the
// merged snapshot to the server (resources_report).
//
// To add one: implement Detector in detectors/<type>.ts, register it in
// detectors/index.ts, and bump its version whenever what it reports for the
// same device would change.

import type {
  DetectedResource,
  ResourcePlatform,
  ResourceTypeId,
} from "@bd777/foundry-protocol";
import { execBounded, type ExecOptions, type ExecResult } from "./exec.js";
import { errorMessage } from "../utils.js";

/** An instance as a detector reports it; the scanner adds `detector`. */
export type DetectedInstance = Omit<DetectedResource, "detector">;

export interface DetectContext {
  /** Aborted when the detector's time is up; pass it on to slow work. */
  signal: AbortSignal;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /**
   * Runs a program without a shell, bounded by the detector's own limit
   * (and timeoutMs when shorter); its process group is killed on timeout.
   */
  exec(
    command: string,
    args: string[],
    options?: Omit<ExecOptions, "signal">,
  ): Promise<ExecResult>;
  /** Folders of the workspaces this worker serves (disk detection). */
  workspacePaths(): string[];
}

export interface Detector {
  /** e.g. "browser", "simulator.ios", "computer_use.macos.foundry-worker". */
  id: string;
  /** Raised whenever its logic changes; reported with each instance. */
  version: number;
  type: ResourceTypeId;
  /** Where it runs; elsewhere it is skipped (reports nothing). */
  platforms: NodeJS.Platform[];
  /** How often it runs after the scan at connect. */
  intervalMs: number;
  /** Its time limit per run: 3 s usually, at most 10 s. */
  timeoutMs: number;
  detect(context: DetectContext): Promise<DetectedInstance[]>;
}

/** The longest any detector may take. */
export const maxDetectorTimeoutMs = 10_000;

/** A detector as instances and reports name it: "<id>@<version>". */
export function detectorName(detector: Detector): string {
  return `${detector.id}@${detector.version}`;
}

/** The resource platform of a Node platform. */
export function resourcePlatform(platform: NodeJS.Platform): ResourcePlatform {
  return platform === "darwin"
    ? "macos"
    : platform === "win32"
      ? "windows"
      : platform === "linux"
        ? "linux"
        : "any";
}

export interface DetectorOutcome {
  instances: DetectedResource[];
  error?: string;
}

/**
 * Runs one detector within its time limit. A detector that throws or runs
 * out of time yields its error, never an exception.
 */
export async function runDetector(
  detector: Detector,
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    workspacePaths?: () => string[];
  } = {},
): Promise<DetectorOutcome> {
  const platform = options.platform ?? process.platform;
  if (!detector.platforms.includes(platform)) return { instances: [] };
  const timeoutMs = Math.min(
    Math.max(detector.timeoutMs, 1),
    maxDetectorTimeoutMs,
  );
  const controller = new AbortController();
  const env = options.env ?? process.env;
  const context: DetectContext = {
    signal: controller.signal,
    platform,
    env,
    exec: (command, args, execOptions = {}) =>
      execBounded(command, args, {
        env,
        ...execOptions,
        signal: controller.signal,
      }),
    workspacePaths: options.workspacePaths ?? (() => []),
  };
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Settled first, so what the detector returns once aborted is not
      // taken for a result.
      reject(new Error(`timed out after ${timeoutMs}ms`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    const found = await Promise.race([detector.detect(context), timedOut]);
    const name = detectorName(detector);
    return {
      instances: found.map((instance) => ({ ...instance, detector: name })),
    };
  } catch (error) {
    return {
      instances: [],
      error: errorMessage(error),
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
