import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  captureProcess,
  type CommandInvocation,
  type CommandOutput,
} from "./evidence-collectors.js";
import { isSandboxError, sandboxLaunch } from "./sandbox/index.js";

/** Only the frozen candidate, checker and output are exposed. Network is denied. */
export async function runEvidenceCommand(
  invocation: CommandInvocation,
  candidate: string,
  output: string,
): Promise<CommandOutput> {
  let launch;
  try {
    launch = sandboxLaunch(
      {
        kind: "offline_command",
        policyFile: resolve(output, "..", "checker.sb"),
        workdir: invocation.cwd,
        readRoots: [candidate],
        writeRoot: output,
        // Project commands run without a checker bundle.
        readOnlyPaths: [resolve(output, "checker")].filter(existsSync),
      },
      invocation.executable,
      invocation.args,
    );
  } catch (error) {
    if (isSandboxError(error))
      throw new Error("verification_isolation_unavailable");
    throw error;
  }
  return captureProcess({
    ...invocation,
    executable: launch.command,
    args: launch.args,
    env: {
      ...invocation.env,
      HOME: output,
      TMPDIR: output,
      TMP: output,
      TEMP: output,
    },
  });
}
