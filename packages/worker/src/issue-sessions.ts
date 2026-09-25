import { resolve } from "node:path";
import {
  executorEnvironment,
  issueSandboxProfile,
} from "./execution-sandbox.js";
import { ExecutionStore } from "./execution-storage.js";
import type { SessionAmbientEnv } from "./session-ambient.js";
import type { WorkspaceSandbox } from "./session/index.js";

/**
 * How an orchestrated session bound to an Issue runs: in the Issue's
 * candidate, inside the same sandbox as the Issue executor, so parallel
 * orchestrated writes never reach the workspace root. The environment exists
 * while an Issue run is live; its absence is fatal rather than silently
 * falling back to the root.
 */
export function issueSessionExecution(
  workspaceId: string,
  issueId: string,
  sessionId: string,
  ambient: SessionAmbientEnv,
  store = new ExecutionStore(),
): { cwd: string; stateRoot: string; sandbox: WorkspaceSandbox } {
  const environment = store.environment(workspaceId, issueId);
  const registration = store.registration(workspaceId);
  if (!environment?.directory?.trim() || !registration)
    throw new Error(
      `issue environment for ${issueId} is not available; start the issue run before creating an issue-backed session`,
    );
  return {
    cwd: environment.cwd,
    // Session records stay beside the candidate, never inside it.
    stateRoot: environment.directory,
    sandbox: {
      profile: issueSandboxProfile(environment, registration),
      env: executorEnvironment(environment),
      stderrFile: resolve(environment.scratch, `session-${sessionId}.log`),
      ambient,
    },
  };
}
