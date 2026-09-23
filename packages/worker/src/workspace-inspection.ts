import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { canonical, ExecutionStore } from "./execution-storage.js";
import { git } from "./execution-git.js";
import { scanRepositories } from "./repository-registry.js";

/** Reads root Git state on demand; full discovery only runs on explicit rescan. */
export async function inspectWorkspace(
  sourcePath: string,
  workspaceId: string,
  rescan = false,
  store = new ExecutionStore(),
) {
  const source = canonical(sourcePath);
  let registration = store.registration(workspaceId);
  if (registration && canonical(registration.sourcePath) !== source)
    throw new Error("Workspace registration path mismatch");
  if (rescan)
    registration = await store.lock(workspaceId, "registration", () =>
      scanRepositories(source, workspaceId, store),
    );
  let gitState: "ready" | "unborn" | "not_git" | "nested" | "error" = "not_git";
  let branch = "",
    head = "",
    containingRepository = "";
  let trackedChanges: boolean | undefined;
  const errors = [...(registration?.errors ?? [])];
  try {
    containingRepository = await git(source, ["rev-parse", "--show-toplevel"], {
      optional: true,
    });
    if (containingRepository && canonical(containingRepository) !== source)
      gitState = "nested";
    else if (containingRepository) {
      branch = await git(source, ["symbolic-ref", "--short", "-q", "HEAD"], {
        optional: true,
      });
      head = await git(source, ["rev-parse", "--verify", "HEAD"], {
        optional: true,
      });
      gitState = head ? "ready" : "unborn";
      trackedChanges = Boolean(
        await git(source, ["status", "--porcelain", "--untracked-files=no"], {
          env: { GIT_OPTIONAL_LOCKS: "0" },
        }),
      );
    } else if (existsSync(resolve(source, ".git"))) {
      gitState = "error";
      errors.push("Root Git metadata could not be read");
    }
  } catch (error) {
    gitState = "error";
    errors.push(String(error));
  }
  return {
    workspaceId,
    sourcePath: source,
    inspectedAt: new Date().toISOString(),
    scannedAt: registration?.scannedAt,
    gitState,
    branch,
    head,
    containingRepository,
    trackedChanges,
    uniqueRepositoryCount: new Set(
      (registration?.repositories ?? [])
        .filter((repo) => repo.commonDirectory)
        .map((repo) => repo.commonDirectory),
    ).size,
    linkedWorktreeCount: (registration?.repositories ?? []).filter(
      (repo) => repo.gitDirectory && repo.gitDirectory !== repo.commonDirectory,
    ).length,
    repositories: (registration?.repositories ?? []).map((repo) => ({
      id: repo.id,
      path: repo.relativePath,
      kind: repo.kind,
      baseline: repo.baseline,
      status: repo.status,
      linkedWorktree: Boolean(
        repo.gitDirectory && repo.gitDirectory !== repo.commonDirectory,
      ),
      error: repo.error,
    })),
    errors,
  };
}
