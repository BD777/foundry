// Free space of the volumes the workspaces live on (the home folder's when
// the worker serves none), one instance per volume. Sizes are rounded to
// whole GiB so the inventory changes only when the space really does.

import { stat, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import {
  resourcePlatform,
  type DetectedInstance,
  type Detector,
} from "../detector.js";

const gib = 1024 ** 3;
/** Below either, a volume is short of space. */
const lowFreeBytes = 2 * gib;
const lowFreeShare = 0.05;

export const diskDetector: Detector = {
  id: "disk",
  version: 1,
  type: "disk",
  platforms: ["darwin", "linux", "win32"],
  intervalMs: 10 * 60_000,
  timeoutMs: 3000,
  async detect(context) {
    const paths = context.workspacePaths();
    const volumes = new Map<string, { paths: string[]; path: string }>();
    for (const path of paths.length ? paths : [homedir()]) {
      try {
        const { dev } = await stat(path);
        const volume = volumes.get(String(dev));
        if (volume) volume.paths.push(path);
        else volumes.set(String(dev), { path, paths: [path] });
      } catch {
        // A workspace folder that is gone has no volume to report.
      }
    }
    const instances: DetectedInstance[] = [];
    for (const [dev, volume] of volumes) {
      const space = await statfs(volume.path);
      const free = space.bavail * space.bsize;
      const total = space.blocks * space.bsize;
      const low =
        free < lowFreeBytes || (total > 0 && free / total < lowFreeShare);
      const freeGiB = Math.floor(free / gib);
      instances.push({
        key: `disk/${dev}`,
        type: "disk",
        platform: resourcePlatform(context.platform),
        name: volume.path,
        readiness: {
          ready: !low,
          level: "installed",
          ...(low ? { reason: `Only ${freeGiB} GiB free.` } : {}),
        },
        details: {
          freeGiB: String(freeGiB),
          totalGiB: String(Math.round(total / gib)),
          workspaces: volume.paths.slice(0, 10).join(", "),
        },
      });
    }
    return instances;
  },
};
