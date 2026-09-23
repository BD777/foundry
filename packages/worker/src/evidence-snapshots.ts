import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  CandidateSnapshot,
  SnapshotFile,
  SnapshotRepository,
} from "@foundry/protocol";
import type { IssueEnvironment } from "./execution-types.js";
import { EvidenceStore, digestBytes, digestObject } from "./evidence-store.js";
import { git } from "./execution-git.js";
import { childPath, identifier, within } from "./execution-storage.js";

const exec = promisify(execFile);

export async function sealCandidate(
  environment: IssueEnvironment,
  store: EvidenceStore,
  parentSnapshotId?: string,
): Promise<CandidateSnapshot> {
  if (environment.status !== "review") throw new Error("candidate_not_ready");
  if (parentSnapshotId) {
    const parent = store.readRecord<CandidateSnapshot>(
      "candidate-snapshots",
      parentSnapshotId,
    );
    if (
      parent.environmentId !== environment.id ||
      parent.environmentRevision >= environment.revision
    )
      throw new Error("invalid_parent_snapshot");
  }
  const repositories: SnapshotRepository[] = [];
  const manifest: SnapshotFile[] = [];
  for (const repo of environment.repositories) {
    if (repo.status !== "ready" || !repo.candidate)
      throw new Error("incomplete_repository_snapshot");
    if (
      (await git(repo.worktreePath, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ])) ||
      (await git(repo.worktreePath, ["rev-parse", "HEAD"])) !== repo.candidate
    )
      throw new Error("candidate_changed: seal implementation changes first");
    const treeOid = await git(repo.worktreePath, [
      "rev-parse",
      `${repo.candidate}^{tree}`,
    ]);
    repositories.push({
      repoId: repo.repoId,
      relativePath: repo.relativePath,
      kind: repo.kind,
      parentRepoId: repo.parentId,
      baselineRef: repo.baselineRef,
      baselineCommit: repo.baseline,
      candidateCommit: repo.candidate,
      treeOid,
    });
    const listing = await git(repo.worktreePath, [
      "ls-tree",
      "-rz",
      "--full-tree",
      repo.candidate,
    ]);
    for (const entry of listing.split("\0").filter(Boolean)) {
      const match = /^(\d+) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error("invalid_git_manifest");
      const [, mode, type, oid, path] = match as unknown as [
        string,
        string,
        string,
        string,
        string,
      ];
      const file = resolve(repo.worktreePath, path);
      if (!within(repo.worktreePath, file)) throw new Error("unsafe_git_path");
      const bytes =
        type === "commit"
          ? Buffer.from(oid)
          : (
              await exec(
                "git",
                [
                  "-c",
                  "core.hooksPath=/dev/null",
                  "-C",
                  repo.worktreePath,
                  "cat-file",
                  "blob",
                  oid,
                ],
                {
                  encoding: "buffer",
                  maxBuffer: 100 * 1024 * 1024,
                  env: {
                    PATH: process.env.PATH,
                    GIT_CONFIG_NOSYSTEM: "1",
                    GIT_CONFIG_GLOBAL: "/dev/null",
                  },
                },
              )
            ).stdout;
      manifest.push({
        repoId: repo.repoId,
        path,
        kind:
          type === "commit"
            ? "gitlink"
            : mode === "120000"
              ? "symlink"
              : "file",
        mode,
        digest: digestBytes(bytes),
      });
    }
    if (
      (await git(repo.worktreePath, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ])) ||
      (await git(repo.worktreePath, ["rev-parse", "HEAD"])) !== repo.candidate
    )
      throw new Error("candidate_changed_during_snapshot");
  }
  repositories.sort((a, b) => a.repoId.localeCompare(b.repoId));
  manifest.sort((a, b) =>
    `${a.repoId}/${a.path}`.localeCompare(`${b.repoId}/${b.path}`),
  );
  const manifestMaterial = store.sealMaterial(
    "Candidate file manifest",
    "data",
    Buffer.from(JSON.stringify(manifest)),
  );
  const record = store.record("snap");
  const snapshot: CandidateSnapshot = {
    ...record,
    environmentId: environment.id,
    environmentRevision: environment.revision,
    purpose: "candidate",
    parentSnapshotId,
    repositories,
    fileManifestMaterialId: manifestMaterial.id,
    contentDigest: digestObject({
      repositories: repositories.map(
        ({ candidateCommit, ...identity }) => identity,
      ),
      manifest,
    }),
    capturedAt: record.createdAt,
  };
  store.sealRecord("candidate-snapshots", snapshot, "CandidateSnapshot");
  return snapshot;
}

/** Extract exact Git blobs, never symlink dependencies back to canonical code. */
export async function materializeCandidate(
  snapshot: CandidateSnapshot,
  environment: IssueEnvironment,
  store: EvidenceStore,
  destination: string,
): Promise<void> {
  const manifest = JSON.parse(
    store.readMaterial(snapshot.fileManifestMaterialId).toString(),
  ) as SnapshotFile[];
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const file of manifest.filter((f) => f.kind !== "gitlink")) {
    const identity = snapshot.repositories.find(
      (r) => r.repoId === file.repoId,
    )!;
    const repo = environment.repositories.find((r) => r.repoId === file.repoId);
    if (!repo) throw new Error("repository_set_changed");
    const root =
      identity.relativePath === "."
        ? destination
        : childPath(destination, identity.relativePath);
    const target = resolve(root, file.path);
    if (!within(root, target)) throw new Error("unsafe_snapshot_path");
    const result = await exec(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        repo.worktreePath,
        "show",
        `${identity.candidateCommit}:${file.path}`,
      ],
      {
        encoding: "buffer",
        maxBuffer: 100 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      },
    );
    if (digestBytes(result.stdout) !== file.digest)
      throw new Error("snapshot_blob_corrupt");
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (!within(realpathSync(destination), realpathSync(dirname(target))))
      throw new Error("snapshot_symlink_escape");
    if (file.kind === "symlink") {
      const link = result.stdout.toString();
      if (
        !within(destination, resolve(dirname(target), link)) ||
        link.startsWith("/")
      )
        throw new Error("external_snapshot_symlink");
      symlinkSync(link, target);
    } else {
      if (lstatSafe(target)) throw new Error("snapshot_path_collision");
      writeFileSync(target, result.stdout, {
        flag: "wx",
        mode: file.mode === "100755" ? 0o500 : 0o400,
      });
    }
  }
}
function lstatSafe(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

export async function assertSnapshotCurrent(
  snapshot: CandidateSnapshot,
  environment: IssueEnvironment,
  store: EvidenceStore,
  checkBaseline = true,
): Promise<void> {
  if (
    snapshot.environmentId !== environment.id ||
    snapshot.environmentRevision !== environment.revision ||
    snapshot.repositories.length !== environment.repositories.length
  )
    throw new Error("candidate_changed");
  store.readMaterial(snapshot.fileManifestMaterialId);
  for (const frozen of snapshot.repositories) {
    identifier(frozen.repoId);
    const repo = environment.repositories.find(
      (r) => r.repoId === frozen.repoId,
    );
    if (
      !repo ||
      repo.candidate !== frozen.candidateCommit ||
      repo.baseline !== frozen.baselineCommit ||
      (await git(repo.worktreePath, ["rev-parse", "HEAD"])) !==
        frozen.candidateCommit ||
      (await git(repo.worktreePath, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]))
    )
      throw new Error("candidate_changed");
    if (
      checkBaseline &&
      (await git(repo.sourcePath, ["rev-parse", frozen.baselineRef])) !==
        frozen.baselineCommit
    )
      throw new Error(
        "baseline_changed: align candidate, reverify and request a new human Accept",
      );
  }
}
