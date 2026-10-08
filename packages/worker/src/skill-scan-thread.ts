/**
 * Scans skill folders off the main thread. A scan reads and hashes whole skill
 * trees; on the daemon's thread it starved the server connection of its
 * heartbeat, and the server dropped the device mid-scan.
 */
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import type { DeviceSkill } from "@bd777/foundry-protocol";
import { scanSkillRoots, toDeviceSkill } from "./skill-scanner.js";

export function scanDeviceSkills(roots: string[]): Promise<DeviceSkill[]> {
  return new Promise((resolve, reject) => {
    const thread = new Worker(new URL(import.meta.url), {
      workerData: { roots },
    });
    thread.once(
      "message",
      (message: { skills?: DeviceSkill[]; error?: string }) =>
        message.error
          ? reject(new Error(message.error))
          : resolve(message.skills ?? []),
    );
    thread.once("error", reject);
    thread.once("exit", (code) => {
      if (code !== 0) reject(new Error(`Skill scan stopped with code ${code}`));
    });
  });
}

if (!isMainThread && parentPort && (workerData as { roots?: unknown })?.roots) {
  try {
    const roots = (workerData as { roots: string[] }).roots;
    parentPort.postMessage({
      skills: scanSkillRoots(roots, "", true, { cache: true }).map(
        toDeviceSkill,
      ),
    });
  } catch (error) {
    parentPort.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
