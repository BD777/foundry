// The device's compute: one instance per device that sessions of its owner
// may lease to run commands here (providers/compute.ts), with its CPUs,
// memory, OS and load. It is ready only while the owner allows remote
// commands on this device (compute-settings.ts). Load is the 5-minute
// average to one decimal, so the inventory changes at most once per scan.

import { availableParallelism, loadavg, release, totalmem } from "node:os";
import {
  computeBackend,
  type ResourceReadiness,
  type ResourceSourceSettings,
} from "@bd777/foundry-protocol";
import { resourceSettings } from "../compute-settings.js";
import {
  resourcePlatform,
  type DetectedInstance,
  type Detector,
} from "../detector.js";

const gib = 1024 ** 3;

/** Why the instance is unready while remote commands are off. */
export const remoteCommandsOffReason =
  'Remote commands are off on this device: its owner turns on "Allow remote commands from my sessions" on the Resources page.';

export function createComputeDetector(
  settings: () => ResourceSourceSettings = () => resourceSettings.get(),
): Detector {
  return {
    id: "compute",
    version: 1,
    type: "compute",
    platforms: ["darwin", "linux", "win32"],
    intervalMs: 5 * 60_000,
    timeoutMs: 1000,
    async detect(context): Promise<DetectedInstance[]> {
      const cpus = availableParallelism();
      const memoryGiB = Math.round(totalmem() / gib);
      const platform = resourcePlatform(context.platform);
      const readiness: ResourceReadiness = settings().allowRemoteCommands
        ? { ready: true, level: "configured" }
        : {
            ready: false,
            level: "installed",
            reason: remoteCommandsOffReason,
            missing: ["remote_commands_off"],
          };
      const details: Record<string, string> = {
        cpus: String(cpus),
        memoryGiB: String(memoryGiB),
        os: platform,
        osVersion: release(),
        arch: process.arch,
      };
      // Windows has no load average (always zeros).
      if (context.platform !== "win32")
        details.loadAvg = loadavg()[1]!.toFixed(1);
      return [
        {
          key: "compute",
          type: "compute",
          platform,
          name: `Compute (${cpus} CPUs, ${memoryGiB} GiB)`,
          readiness,
          backends: [{ id: computeBackend, mode: "remote_ops", readiness }],
          details,
        },
      ];
    },
  };
}

export const computeDetector = createComputeDetector();
