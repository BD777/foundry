import type { CandidateSnapshot } from "@foundry/protocol";
import type { IssueEnvironment } from "./execution-types.js";
import { git } from "./execution-git.js";

/** Git-observed differences between each frozen baseline and candidate, not Agent output. */
export async function candidateChangeManifest(
  snapshot: CandidateSnapshot,
  environment: IssueEnvironment,
): Promise<Buffer> {
  const repositories = [];
  for (const frozen of snapshot.repositories) {
    const repo = environment.repositories.find(
      (r) => r.repoId === frozen.repoId,
    );
    if (!repo) throw new Error("snapshot_repository_missing");
    const raw = await git(repo.worktreePath, [
      "diff",
      "--name-status",
      "-z",
      "--no-renames",
      frozen.baselineCommit,
      frozen.candidateCommit,
      "--",
    ]);
    const fields = raw.split("\0").filter(Boolean);
    if (fields.length % 2) throw new Error("incomplete_change_manifest");
    const changes = [];
    for (let index = 0; index < fields.length; index += 2)
      changes.push({ status: fields[index], path: fields[index + 1] });
    repositories.push({
      relativePath: frozen.relativePath,
      repoId: frozen.repoId,
      baselineCommit: frozen.baselineCommit,
      candidateCommit: frozen.candidateCommit,
      changes,
    });
  }
  return Buffer.from(
    JSON.stringify(
      {
        source: "Foundry Worker: git diff of frozen baseline and candidate",
        candidateSnapshotId: snapshot.id,
        repositories,
        limitations: [
          "Only registered repositories and frozen Git-tracked deliverables are represented; ignored external inputs are not claimed.",
        ],
      },
      null,
      2,
    ),
  );
}
