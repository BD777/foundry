import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ExecutionStore } from "./execution-storage.js";
import type { IssueCompletion } from "./transport.js";
import { writeJSON } from "./storage.js";

/**
 * The result of an Issue execution this process no longer runs, for the
 * server's recover_session: the completion it recorded, or — when the worker
 * stopped mid-run — an interruption that keeps the candidate for a retry.
 * Undefined when this device never ran that attempt.
 */
export function recoveredIssueCompletion(
  workspaceId: string,
  issueId: string,
  runId: string,
  store = new ExecutionStore(),
): IssueCompletion | undefined {
  const runDir = issueRunDirectory(workspaceId, issueId, runId, store);
  if (!runDir) return undefined;
  const completionPath = resolve(runDir, "completion.json");
  if (existsSync(completionPath))
    return JSON.parse(readFileSync(completionPath, "utf8")) as IssueCompletion;
  const environment = store.environment(workspaceId, issueId);
  const error =
    "Worker process stopped. Candidate files and the native session are retained; retry to resume.";
  if (environment) {
    environment.status = "failed";
    environment.error = error;
    store.saveEnvironment(environment);
  }
  const completion: IssueCompletion = {
    runId,
    artifact: {
      id: `art_${runId}`,
      issueId,
      kind: "text",
      title: "Interrupted execution",
      summary: error,
    },
    checks: [error],
    error,
    environmentId: environment?.id,
    executionCwd: environment?.cwd,
  };
  writeJSON(completionPath, completion);
  return completion;
}

/** The completion an attempt already recorded, if it finished here. */
export function recordedIssueCompletion(
  workspaceId: string,
  issueId: string,
  runId: string,
  store = new ExecutionStore(),
): IssueCompletion | undefined {
  const runDir = issueRunDirectory(workspaceId, issueId, runId, store);
  const completionPath = runDir && resolve(runDir, "completion.json");
  return completionPath && existsSync(completionPath)
    ? (JSON.parse(readFileSync(completionPath, "utf8")) as IssueCompletion)
    : undefined;
}

function issueRunDirectory(
  workspaceId: string,
  issueId: string,
  runId: string,
  store: ExecutionStore,
): string | undefined {
  const roots = new Set([resolve(store.executionRoot, workspaceId, "runs")]);
  const environment = store.environment(workspaceId, issueId);
  if (environment) roots.add(resolve(environment.directory, "../../runs"));
  const pointers = resolve(
    store.metadata(workspaceId),
    "environment-locations",
  );
  if (existsSync(pointers))
    for (const name of readdirSync(pointers)) {
      if (!name.endsWith(".json")) continue;
      const other = store.environment(workspaceId, name.slice(0, -5));
      if (other) roots.add(resolve(other.directory, "../../runs"));
    }
  return [...roots]
    .map((root) => resolve(root, runId))
    .find((dir) => existsSync(resolve(dir, "run.json")));
}
