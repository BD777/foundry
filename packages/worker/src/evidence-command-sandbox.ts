import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  captureProcess,
  type CommandInvocation,
  type CommandOutput,
} from "./evidence-collectors.js";
import { isSandboxError, sandboxLaunch } from "./sandbox/index.js";
import {
  corepackHome,
  type DependencySandbox,
} from "./evidence-dependencies.js";

/** Only the frozen candidate, checker and output are exposed. Network is denied. */
export async function runEvidenceCommand(
  invocation: CommandInvocation,
  candidate: string,
  output: string,
  dependencies?: DependencySandbox,
): Promise<CommandOutput> {
  const corepack = corepackHome();
  let launch;
  try {
    launch = sandboxLaunch(
      {
        kind: "offline_command",
        policyFile: resolve(output, "..", "checker.sb"),
        workdir: invocation.cwd,
        // The check's own copy: commands may add files (a build's output),
        // while its tracked files stay read-only by permission.
        readRoots: [
          ...(corepack ? [corepack] : []),
          ...(dependencies?.readRoots ?? []),
        ],
        writeRoot: output,
        writeRoots: [candidate],
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
      ...(corepack ? { COREPACK_HOME: corepack } : {}),
      // Foundry prepared the dependencies from the lockfile already; pnpm
      // must not try to reinstall them (offline, without its store) first.
      pnpm_config_verify_deps_before_run: "false",
      ...dependencies?.env,
      ...(dependencies?.pathPrefix
        ? {
            PATH: `${dependencies.pathPrefix}:${invocation.env.PATH ?? ""}`,
          }
        : {}),
    },
  });
}
