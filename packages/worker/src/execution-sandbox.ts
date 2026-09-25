import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { canonical } from "./execution-storage.js";
import { foundryStatePath } from "./state-root.js";
import { isSandboxError, sandboxLaunch } from "./sandbox/index.js";
import type {
  IssueEnvironment,
  WorkspaceRegistration,
} from "./execution-types.js";

/** The one private-state subdir an issue executor may read skill files from. */
function skillSetsReadRoot(): string {
  return foundryStatePath("skill-sets");
}

/**
 * Confine an Issue executor (or its preview) to its candidate and scratch:
 * the source workspace stays readable, and repositories that are not ready in
 * this candidate, plus each worktree's Git metadata, stay read-only.
 */
export function sandboxCommand(
  environment: IssueEnvironment,
  registration: WorkspaceRegistration,
  command: string,
  args: string[],
): { command: string; args: string[] } {
  const denied = registration.repositories
    .filter(
      (repo) =>
        !environment.repositories.some(
          (candidate) =>
            candidate.repoId === repo.id && candidate.status === "ready",
        ),
    )
    .map((repo) => resolve(environment.cwd, repo.relativePath));
  try {
    return sandboxLaunch(
      {
        kind: "writable_tree",
        // Policy remains outside candidate/scratch: the executor cannot change it.
        policyFile: resolve(environment.directory, "executor.sb"),
        workdir: environment.cwd,
        readRoots: [environment.sourcePath],
        writeRoots: [environment.cwd, environment.scratch].map(canonical),
        // Only the verified promoted-skill tree, just downloaded and checksum-checked.
        protectedReadRoots: [skillSetsReadRoot()],
        readOnlyDirectories: denied,
        readOnlyPaths: environment.repositories.map((repo) =>
          resolve(repo.worktreePath, ".git"),
        ),
        controlServerURL: environment.controlServerURL,
      },
      command,
      args,
    );
  } catch (error) {
    throw issueIsolationError(error);
  }
}

// Keep the messages Issues have always shown for an unavailable backend.
function issueIsolationError(error: unknown): unknown {
  if (!isSandboxError(error)) return error;
  switch (error.code) {
    case "unsupported_platform":
      return new Error(
        `Issue execution isolation is not available on ${process.platform}`,
      );
    case "backend_missing":
      return new Error(
        `${process.platform === "linux" ? "Linux " : ""}Issue isolation ${error.message}`,
      );
    case "user_namespaces_unavailable":
      return new Error(
        `Linux user namespaces are unavailable: ${error.message}`,
      );
    default:
      return error;
  }
}

export function executorEnvironment(
  environment: IssueEnvironment,
): NodeJS.ProcessEnv {
  const codexHome = resolve(environment.scratch, "codex");
  const claudeHome = resolve(environment.scratch, "claude");
  const temp = resolve(environment.scratch, "tmp");
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
    if (source && target && existsSync(source) && !existsSync(target))
      copyFileSync(source, target);
  }
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (/FOUNDRY.*(?:TOKEN|PAIRING|CONTROL|CREDENTIAL)/i.test(key))
      delete inherited[key];
  }
  return {
    ...inherited,
    HOME: environment.scratch,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    TMPDIR: temp,
    CLAUDE_CODE_TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    FOUNDRY_WORKSPACE: environment.cwd,
    FOUNDRY_ROOT_WORKSPACE: environment.sourcePath,
    FOUNDRY_EXECUTION_SESSION_ROOT: resolve(environment.scratch, "sessions"),
  };
}
