import { resolve } from "node:path";
import { canonical } from "./execution-storage.js";
import {
  isolatedAgentEnvironment,
  skillSetsReadRoot,
} from "./session/isolated-environment.js";
import {
  isSandboxError,
  sandboxLaunch,
  type WritableTreeProfile,
} from "./sandbox/index.js";
import type {
  IssueEnvironment,
  WorkspaceRegistration,
} from "./execution-types.js";

// The environment every sandboxed agent session gets lives with the session
// runtime; Issue code keeps importing it from here.
export { isolatedAgentEnvironment, skillSetsReadRoot };

/**
 * The sandbox of every process working in an Issue's candidate: the executor,
 * its preview and orchestrated sessions bound to the Issue. The source
 * workspace stays readable; repositories not ready in this candidate, plus
 * each worktree's Git metadata, stay read-only.
 */
export function issueSandboxProfile(
  environment: IssueEnvironment,
  registration: WorkspaceRegistration,
  /** Unix sockets outside the candidate the process may connect to. */
  connectSockets: string[] = [],
): WritableTreeProfile {
  const denied = registration.repositories
    .filter(
      (repo) =>
        !environment.repositories.some(
          (candidate) =>
            candidate.repoId === repo.id && candidate.status === "ready",
        ),
    )
    .map((repo) => resolve(environment.cwd, repo.relativePath));
  return {
    kind: "writable_tree",
    // Policy remains outside candidate/scratch: the process cannot change it.
    policyFile: resolve(environment.directory, "executor.sb"),
    workdir: environment.cwd,
    readRoots: [environment.sourcePath],
    writeRoots: [environment.cwd, environment.scratch].map(canonical),
    // Only the verified promoted-skill tree, just downloaded and checksum-checked.
    // The verified promoted-skill tree and the contract's reference files.
    protectedReadRoots: [
      skillSetsReadRoot(),
      resolve(environment.directory, "references"),
    ],
    readOnlyDirectories: denied,
    readOnlyPaths: environment.repositories.map((repo) =>
      resolve(repo.worktreePath, ".git"),
    ),
    connectSockets,
    executables: [],
    userFiles: environment.userFiles ?? "hidden",
  };
}

/** A command line that runs inside the Issue's sandbox. */
export function sandboxCommand(
  environment: IssueEnvironment,
  registration: WorkspaceRegistration,
  command: string,
  args: string[],
  connectSockets: string[] = [],
): { command: string; args: string[] } {
  try {
    return sandboxLaunch(
      issueSandboxProfile(environment, registration, connectSockets),
      command,
      args,
    );
  } catch (error) {
    throw issueIsolationError(error);
  }
}

export function issueIsolationError(error: unknown): unknown {
  return isSandboxError(error)
    ? new Error(`Issue execution isolation is unavailable: ${error.message}`)
    : error;
}

export function executorEnvironment(
  environment: IssueEnvironment,
  uid = process.getuid?.(),
): NodeJS.ProcessEnv {
  return {
    ...isolatedAgentEnvironment(environment.scratch),
    FOUNDRY_WORKSPACE: environment.cwd,
    FOUNDRY_ROOT_WORKSPACE: environment.sourcePath,
    // An execution always runs inside Foundry's sandbox, so a worker running
    // as root says so truthfully; Claude Code then allows skipping prompts.
    ...(uid === 0 ? { IS_SANDBOX: "1" } : {}),
  };
}
