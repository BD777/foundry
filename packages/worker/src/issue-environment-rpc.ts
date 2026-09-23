import { ExecutionStore } from "./execution-storage.js";
import { prepareAcceptance, applyAcceptance } from "./workspace-acceptance.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { git } from "./execution-git.js";
import { assertMutable } from "./issue-environments.js";
import { cancelIssueExecution, executionActive } from "./execution-process.js";
import { cleanupEnvironment } from "./issue-environments.js";
import { environmentStatus } from "./environment-status.js";
import { stopIssuePreview } from "./issue-preview.js";
import { steerIssue } from "./issue-steering.js";
import { stopEvidenceHTTPServices } from "./evidence-http-service.js";

export async function issueEnvironmentAction(
  payload: {
    action: string;
    workspaceId: string;
    issueId: string;
    revision: number;
    message?: string;
    expectedRunId?: string;
  },
  store = new ExecutionStore(),
): Promise<{
  status: string;
  revision: number;
  review?: unknown;
  environment?: unknown;
}> {
  if (payload.action === "status")
    return {
      status: "ok",
      revision: 0,
      environment: environmentStatus(
        payload.workspaceId,
        payload.issueId,
        store,
      ),
    };
  if (payload.action === "steer") {
    await steerIssue(
      payload.issueId,
      payload.expectedRunId ?? "",
      payload.message ?? "",
    );
    return { status: "steered", revision: 0 };
  }
  if (payload.action === "preview_stop") {
    await stopIssuePreview(payload.issueId);
    return { status: "stopped", revision: 0 };
  }
  if (payload.action === "cancel") {
    cancelIssueExecution(payload.issueId);
    return { status: "cancel_requested", revision: 0 };
  }
  if (payload.action === "cleanup")
    return store.lock(
      payload.workspaceId,
      `execution-${payload.issueId}`,
      async () => {
        await stopIssuePreview(payload.issueId);
        stopEvidenceHTTPServices(payload.issueId);
        if (executionActive(payload.issueId))
          throw new Error("Issue is still running");
        const environment = store.environment(
          payload.workspaceId,
          payload.issueId,
        );
        if (!environment) throw new Error("Candidate is missing");
        await cleanupEnvironment(environment, store);
        return { status: environment.status, revision: environment.revision };
      },
    );
  if (payload.action === "check_retry") {
    await stopIssuePreview(payload.issueId);
    const environment = store.environment(payload.workspaceId, payload.issueId);
    if (!environment) throw new Error("Candidate environment is missing");
    assertMutable(environment);
    return { status: environment.status, revision: environment.revision };
  }
  if (payload.action === "inspect") {
    const environment = store.environment(payload.workspaceId, payload.issueId);
    if (!environment) throw new Error("Candidate environment is missing");
    const repositories = [];
    let remaining = 800_000;
    for (const repo of environment.repositories) {
      const diff = await git(repo.worktreePath, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        repo.baseline,
        repo.candidate ?? "HEAD",
        "--",
        ".",
      ]);
      const limit = Math.min(remaining, 200_000);
      repositories.push({
        path: repo.relativePath,
        baseline: repo.baseline,
        candidate: repo.candidate,
        diff: diff.slice(0, limit),
        truncated: diff.length > limit,
      });
      remaining -= Math.min(diff.length, limit);
    }
    return {
      status: environment.status,
      revision: environment.revision,
      review: { cwd: environment.cwd, repositories },
    };
  }
  if (payload.action !== "accept")
    throw new Error("Unsupported environment action");
  // Only evidence_request/accept can bind a decision and immutable review.
  throw new Error(
    "accept_protocol_upgrade_required: legacy environment Accept is disabled",
  );
  /* Legacy journal recovery remains in workspace-acceptance.ts. */
}
