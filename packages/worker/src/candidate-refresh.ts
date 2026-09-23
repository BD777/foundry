import { ExecutionStore } from "./execution-storage.js";
import { git, gitCommit, commitIdentity } from "./execution-git.js";
import type { IssueEnvironment } from "./execution-types.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { identifier } from "./execution-storage.js";
import type { WorkspaceAcceptance } from "./execution-types.js";

/** Bring accepted commits into a requested revision; conflicts stay in candidate. */
export async function refreshCandidate(
  environment: IssueEnvironment,
  store = new ExecutionStore(),
): Promise<IssueEnvironment> {
  if (environment.acceptanceId) {
    const journal = JSON.parse(
      readFileSync(
        resolve(
          environment.directory,
          "../../acceptances",
          identifier(environment.acceptanceId),
          "acceptance.json",
        ),
        "utf8",
      ),
    ) as WorkspaceAcceptance;
    if (journal.status === "applying" || journal.status === "integrated")
      throw new Error(
        "integration_recovery_required: reconcile the existing acceptance before changing the candidate",
      );
  }
  const conflicts: string[] = [];
  for (const repo of [...environment.repositories].sort(
    (a, b) => b.relativePath.length - a.relativePath.length,
  )) {
    if (repo.status !== "ready") continue;
    const unmerged = await git(repo.worktreePath, [
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    if (unmerged) {
      conflicts.push(`${repo.relativePath}: ${unmerged}`);
      continue;
    }
    await git(repo.worktreePath, ["add", "-A", "--", "."]);
    await gitCommit(
      repo.worktreePath,
      `Checkpoint ${environment.issueId} before refreshing baseline`,
    );
    const latest = await git(repo.sourcePath, [
      "rev-parse",
      "--verify",
      `${repo.baselineRef}^{commit}`,
    ]);
    try {
      await git(repo.worktreePath, ["merge", "--no-edit", latest], {
        env: commitIdentity,
      });
    } catch (error) {
      if (
        !(await git(repo.worktreePath, [
          "diff",
          "--name-only",
          "--diff-filter=U",
        ]))
      )
        throw error;
      conflicts.push(`${repo.relativePath}: ${String(error)}`);
    }
    repo.baseline = latest;
  }
  environment.revision++;
  delete environment.acceptanceId;
  if (conflicts.length)
    environment.error = `Resolve these merge conflicts in candidate files before finishing:\n${conflicts.join("\n")}`;
  store.saveEnvironment(environment);
  return environment;
}
