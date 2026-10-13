// macOS ships stubs in /usr/bin (git, python3, xcrun…) that open the
// "install command line developer tools" dialog when run without them. A
// detector must never prompt, so on a Mac those stubs only run once the
// developer tools are known to be installed (`xcode-select -p`, which never
// prompts).

import { basename } from "node:path";
import type { DetectContext } from "../detector.js";
import { findOnPath } from "../exec.js";

const macDeveloperStubs = new Set([
  "git",
  "python3",
  "pip3",
  "xcrun",
  "xcodebuild",
  "clang",
  "make",
  "swift",
]);

let developerToolsCache: { until: number; installed: boolean } | undefined;

/** Whether this Mac has Xcode or the command line developer tools. */
export async function macDeveloperToolsInstalled(
  context: DetectContext,
): Promise<boolean> {
  if (context.platform !== "darwin") return false;
  if (developerToolsCache && developerToolsCache.until > Date.now())
    return developerToolsCache.installed;
  const run = await context.exec("/usr/bin/xcode-select", ["-p"], {
    timeoutMs: 2000,
  });
  const installed = run.code === 0 && run.stdout.trim() !== "";
  developerToolsCache = { until: Date.now() + 10 * 60_000, installed };
  return installed;
}

/**
 * A tool's path on PATH that is safe to run without a prompt, or
 * undefined.
 */
export async function usableTool(
  context: DetectContext,
  name: string,
): Promise<string | undefined> {
  const path = findOnPath(name, context.env, context.platform);
  if (!path) return undefined;
  if (
    context.platform === "darwin" &&
    path.startsWith("/usr/bin/") &&
    macDeveloperStubs.has(basename(path)) &&
    !(await macDeveloperToolsInstalled(context))
  )
    return undefined;
  return path;
}
