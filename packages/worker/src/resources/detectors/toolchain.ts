// Toolchains on PATH and their versions: git, Node.js, Go, Python and, on a
// Mac with Xcode, xcodebuild. A tool that is not on PATH starts nothing.

import {
  resourcePlatform,
  type DetectContext,
  type DetectedInstance,
  type Detector,
} from "../detector.js";
import { firstLine } from "../exec.js";
import { usableTool } from "./developer-tools.js";

interface Toolchain {
  id: string;
  name: string;
  /** Programs tried in order; the first on PATH counts. */
  programs: string[];
  args: string[];
  platforms?: NodeJS.Platform[];
}

const toolchains: Toolchain[] = [
  { id: "git", name: "Git", programs: ["git"], args: ["--version"] },
  { id: "node", name: "Node.js", programs: ["node"], args: ["--version"] },
  { id: "go", name: "Go", programs: ["go"], args: ["version"] },
  {
    id: "python",
    name: "Python",
    programs: ["python3", "python"],
    args: ["--version"],
  },
  {
    id: "xcode",
    name: "Xcode",
    programs: ["xcodebuild"],
    args: ["-version"],
    platforms: ["darwin"],
  },
];

/** The first version number in a tool's output. */
export function versionIn(output: string): string | undefined {
  return /\d+\.\d+(?:\.\d+)?/.exec(output)?.[0];
}

async function detectToolchain(
  context: DetectContext,
  toolchain: Toolchain,
): Promise<DetectedInstance | undefined> {
  if (toolchain.platforms && !toolchain.platforms.includes(context.platform))
    return undefined;
  for (const program of toolchain.programs) {
    const path = await usableTool(context, program);
    if (!path) continue;
    const run = await context.exec(path, toolchain.args, { timeoutMs: 4000 });
    // Windows' python alias opens the Store and exits non-zero: not there.
    if (run.code !== 0) continue;
    const output = `${run.stdout}\n${run.stderr}`;
    const version = versionIn(output);
    return {
      key: `toolchain/${toolchain.id}`,
      type: "toolchain",
      platform: resourcePlatform(context.platform),
      name: version ? `${toolchain.name} ${version}` : toolchain.name,
      readiness: { ready: true, level: "installed" },
      details: {
        path,
        ...(version ? { version } : { output: firstLine(output) }),
      },
    };
  }
  return undefined;
}

export const toolchainDetector: Detector = {
  id: "toolchain",
  version: 1,
  type: "toolchain",
  platforms: ["darwin", "linux", "win32"],
  intervalMs: 30 * 60_000,
  timeoutMs: 8000,
  async detect(context) {
    const found = await Promise.all(
      toolchains.map((toolchain) => detectToolchain(context, toolchain)),
    );
    return found.filter(
      (instance): instance is DetectedInstance => instance !== undefined,
    );
  },
};
