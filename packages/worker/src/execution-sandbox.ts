import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { canonical } from "./execution-storage.js";
import { foundryStatePath } from "./state-root.js";
import {
  isSandboxError,
  sandboxLaunch,
  type WritableTreeProfile,
} from "./sandbox/index.js";
import type {
  IssueEnvironment,
  WorkspaceRegistration,
} from "./execution-types.js";

/** The one private-state subdir an issue executor may read skill files from. */
export function skillSetsReadRoot(): string {
  return foundryStatePath("skill-sets");
}

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

/**
 * The environment of an agent working for an Issue inside a sandbox: its
 * home, temporary space and native session records live in a private
 * scratch directory that holds a copy of the provider login, never in the
 * workspace. Foundry's own credentials are not passed on.
 */
export function isolatedAgentEnvironment(scratch: string): NodeJS.ProcessEnv {
  const codexHome = resolve(scratch, "codex");
  const claudeHome = resolve(scratch, "claude");
  const temp = resolve(scratch, "tmp");
  for (const directory of [codexHome, claudeHome, temp])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Provider authentication stays private and is never staged in the candidate.
  for (const [source, target] of [
    [
      resolve(
        process.env.CODEX_HOME ?? resolve(homedir(), ".codex"),
        "auth.json",
      ),
      resolve(codexHome, "auth.json"),
    ],
    [
      resolve(
        process.env.CODEX_HOME ?? resolve(homedir(), ".codex"),
        "config.toml",
      ),
      resolve(codexHome, "config.toml"),
    ],
    [
      resolve(
        process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), ".claude"),
        ".credentials.json",
      ),
      resolve(claudeHome, ".credentials.json"),
    ],
  ]) {
    // The device's login is the source of truth, copied on every launch:
    // providers rotate refresh tokens, and a copy kept from an earlier run
    // (or one its CLI signed out after a failed refresh) never works again.
    if (source && target && existsSync(source)) copyFileSync(source, target);
  }
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (/FOUNDRY.*(?:TOKEN|PAIRING|CONTROL|CREDENTIAL)/i.test(key))
      delete inherited[key];
  }
  return {
    ...inherited,
    HOME: scratch,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    TMPDIR: temp,
    CLAUDE_CODE_TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    FOUNDRY_EXECUTION_SESSION_ROOT: resolve(scratch, "sessions"),
    // The person's claude.ai connectors (mail, drive, calendar) are outside
    // the Issue; an execution reaches only its candidate and Foundry's tools.
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  };
}
