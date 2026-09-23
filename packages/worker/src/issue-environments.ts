import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  canonical,
  childPath,
  ExecutionStore,
  identifier,
  within,
} from "./execution-storage.js";
import { git, gitCommit } from "./execution-git.js";
import { registerExecutionWorkspace } from "./repository-registry.js";
import type {
  CandidateRepository,
  IssueEnvironment,
  WorkspaceRegistration,
} from "./execution-types.js";

export async function prepareIssueEnvironment(
  source: string,
  workspaceId: string,
  issueId: string,
  store = new ExecutionStore(),
): Promise<IssueEnvironment> {
  identifier(issueId);
  const registration = await registerExecutionWorkspace(
    source,
    workspaceId,
    store,
  );
  const root = registration.repositories.find((repo) => repo.kind === "root");
  if (!root) {
    // A folder inside a larger repository can host Chats, but Issues run in
    // an isolated worktree of a repository root.
    const enclosing = await git(source, ["rev-parse", "--show-toplevel"], {
      optional: true,
    });
    throw new Error(
      enclosing
        ? `Issues need a repository root. This workspace is a folder inside the Git repository at ${enclosing}; register that folder as a workspace to run Issues. Chats work here as they are.`
        : "Workspace root is not ready for worktree execution",
    );
  }
  if (root.status !== "ready")
    throw new Error(
      root.error ?? "Workspace root is not ready for worktree execution",
    );
  return store.lock(workspaceId, `environment-${issueId}`, async () => {
    let environment = store.environment(workspaceId, issueId);
    if (!environment) {
      const directory = dirname(store.environmentPath(workspaceId, issueId));
      if (within(canonical(source), canonical(directory)))
        throw new Error(
          "Candidate environment must be outside source workspace",
        );
      if (existsSync(directory))
        throw new Error(
          "Unregistered candidate directory already exists; refusing to overwrite",
        );
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const now = new Date().toISOString();
      environment = {
        version: 1,
        id: `env_${randomUUID()}`,
        issueId,
        workspaceId,
        sourcePath: canonical(source),
        directory,
        cwd: resolve(directory, "workspace"),
        scratch: resolve(directory, "scratch"),
        revision: 0,
        status: "preparing",
        repositories: [],
        createdAt: now,
        updatedAt: now,
      };
      mkdirSync(environment.scratch, { recursive: true, mode: 0o700 });
      store.saveEnvironment(environment);
    }
    if (environment.sourcePath !== canonical(source))
      throw new Error(
        "Workspace source path changed; relink the environment explicitly",
      );
    assertMutable(environment);
    await prepareRepositoryUnlocked(environment, root.id, registration, store);
    environment.status = "ready";
    store.saveEnvironment(environment);
    return environment;
  });
}

export function assertMutable(environment: IssueEnvironment): void {
  if (
    ["integrated", "abandoned", "cleanup_pending", "cleaned"].includes(
      environment.status,
    )
  )
    throw new Error(`Environment is ${environment.status}`);
  if (environment.acceptanceId)
    throw new Error(
      "An acceptance is pending; finish or reconcile it before changing this candidate",
    );
}

export async function ensureRepository(
  workspaceId: string,
  issueId: string,
  repoId: string,
  store = new ExecutionStore(),
): Promise<IssueEnvironment> {
  return store.lock(workspaceId, `environment-${issueId}`, async () => {
    const environment = store.environment(workspaceId, issueId);
    const registration = store.registration(workspaceId);
    if (!environment || !registration)
      throw new Error("Issue environment is not registered");
    assertMutable(environment);
    await prepareRepositoryUnlocked(environment, repoId, registration, store);
    return environment;
  });
}

async function prepareRepositoryUnlocked(
  environment: IssueEnvironment,
  repoId: string,
  registration: WorkspaceRegistration,
  store: ExecutionStore,
): Promise<CandidateRepository> {
  const repo = registration.repositories.find((item) => item.id === repoId);
  if (!repo) throw new Error("Repository is not registered in this workspace");
  if (repo.status !== "ready")
    throw new Error(repo.error ?? `Repository is ${repo.status}`);
  let candidate = environment.repositories.find(
    (item) => item.repoId === repoId,
  );
  if (candidate?.status === "ready") {
    await validateWorktree(candidate);
    return candidate;
  }
  if (
    repo.parentId &&
    !environment.repositories.some(
      (item) => item.repoId === repo.parentId && item.status === "ready",
    )
  ) {
    await prepareRepositoryUnlocked(
      environment,
      repo.parentId,
      registration,
      store,
    );
  }
  const target =
    repo.relativePath === "."
      ? environment.cwd
      : childPath(environment.cwd, repo.relativePath);
  if (!candidate) {
    let baseline = await git(repo.sourcePath, [
      "rev-parse",
      "--verify",
      `${repo.baseline}^{commit}`,
    ]);
    if (repo.kind === "submodule") {
      const parent = environment.repositories.find(
        (item) => item.repoId === repo.parentId,
      )!;
      const entry = await git(parent.worktreePath, [
        "ls-tree",
        "HEAD",
        "--",
        relative(parent.worktreePath, target),
      ]);
      if (!entry.startsWith("160000 commit "))
        throw new Error(
          "Submodule is absent from the parent candidate baseline",
        );
      baseline = entry.split(/\s+/)[2]!;
      await git(repo.sourcePath, ["cat-file", "-e", `${baseline}^{commit}`]);
    }
    candidate = {
      repoId,
      kind: repo.kind,
      parentId: repo.parentId,
      relativePath: repo.relativePath,
      sourcePath: repo.sourcePath,
      branch: `codex/issue-${environment.issueId}-${repoId}`,
      baseline,
      baselineRef: repo.baseline,
      worktreePath: target,
      status: "preparing",
    };
    environment.repositories.push(candidate);
    store.saveEnvironment(environment);
  }
  try {
    if (existsSync(resolve(target, ".git"))) {
      await validateWorktree(candidate);
    } else {
      if (existsSync(target) && readdirSync(target).length)
        throw new Error(`Candidate path is not empty: ${repo.relativePath}`);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const ref = await git(
        repo.sourcePath,
        ["rev-parse", "--verify", `refs/heads/${candidate.branch}`],
        { optional: true },
      );
      await git(repo.sourcePath, [
        "worktree",
        "add",
        ...(ref ? [] : ["-b", candidate.branch]),
        target,
        ref ? candidate.branch : candidate.baseline,
      ]);
    }
    // Git's per-repository excludes protect independent nested repos and all
    // local Foundry state from accidental root staging, without editing user files.
    const exclude = await git(target, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "info/exclude",
    ]);
    const children = registration.repositories.filter(
      (item) => item.parentId === repo.id && item.kind === "independent",
    );
    const entries = [
      "/.foundry/sessions/",
      "/.foundry/attachments/",
      "/.foundry/runs/",
      "/.foundry/worktrees/",
      "/.foundry/issues/",
      "/.foundry/reviews/",
      "/.foundry/integrations/",
      "/.foundry/daemon.json",
      "/.foundry/repositories.yaml",
      "/artifacts/",
      "/accepted/",
      ...children.map(
        (item) => `/${relative(repo.sourcePath, item.sourcePath)}/`,
      ),
    ];
    await store.lock(
      environment.workspaceId,
      `exclude-${repo.id}`,
      async () => {
        const existing = existsSync(exclude)
          ? readFileSync(exclude, "utf8")
          : "";
        const added = entries.filter(
          (entry) => !existing.split("\n").includes(entry),
        );
        if (added.length) {
          mkdirSync(dirname(exclude), { recursive: true });
          writeFileSync(exclude, `${existing}\n${added.join("\n")}\n`);
        }
      },
    );
    candidate.status = "ready";
    delete candidate.error;
    environment.revision++;
    store.saveEnvironment(environment);
    return candidate;
  } catch (error) {
    candidate.status = "failed";
    candidate.error = String(error);
    store.saveEnvironment(environment);
    throw error;
  }
}

export async function validateWorktree(
  repo: CandidateRepository,
): Promise<void> {
  if (
    canonical(
      await git(repo.worktreePath, ["rev-parse", "--show-toplevel"]),
    ) !== canonical(repo.worktreePath)
  )
    throw new Error("Candidate worktree root changed");
  const common = await git(repo.worktreePath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const sourceCommon = await git(repo.sourcePath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (canonical(common) !== canonical(sourceCommon))
    throw new Error("Candidate belongs to another repository");
  if (
    (await git(repo.worktreePath, ["symbolic-ref", "--quiet", "HEAD"])) !==
    `refs/heads/${repo.branch}`
  )
    throw new Error("Candidate branch changed unexpectedly");
}

export async function snapshotEnvironment(
  environment: IssueEnvironment,
  store = new ExecutionStore(),
): Promise<IssueEnvironment> {
  for (const repo of [...environment.repositories].sort(
    (a, b) => b.relativePath.length - a.relativePath.length,
  )) {
    if (repo.status !== "ready")
      throw new Error(`Repository is not ready: ${repo.relativePath}`);
    await validateWorktree(repo);
    if (
      await git(repo.worktreePath, ["diff", "--name-only", "--diff-filter=U"])
    )
      await git(repo.worktreePath, ["diff", "--check"]);
    await git(repo.worktreePath, ["add", "-A", "--", "."]);
    repo.candidate = await gitCommit(
      repo.worktreePath,
      `Foundry candidate for ${environment.issueId}`,
    );
  }
  environment.revision++;
  environment.status = "review";
  delete environment.acceptanceId;
  delete environment.error;
  store.saveEnvironment(environment);
  return environment;
}

export async function cleanupEnvironment(
  environment: IssueEnvironment,
  store = new ExecutionStore(),
): Promise<void> {
  if (
    !["integrated", "abandoned", "cleanup_pending"].includes(environment.status)
  )
    throw new Error("Only integrated or abandoned environments can be cleaned");
  environment.status = "cleanup_pending";
  store.saveEnvironment(environment);
  for (const repo of [...environment.repositories].sort(
    (a, b) => b.relativePath.length - a.relativePath.length,
  )) {
    if (repo.status === "cleaned") continue;
    if (existsSync(repo.worktreePath)) {
      await validateWorktree(repo);
      if (
        await git(repo.worktreePath, [
          "status",
          "--porcelain",
          "--untracked-files=all",
        ])
      )
        throw new Error(
          `Uncommitted candidate content remains in ${repo.relativePath}`,
        );
      const head = await git(repo.worktreePath, ["rev-parse", "HEAD"]);
      if (
        (await git(repo.sourcePath, [
          "rev-parse",
          `refs/heads/${repo.branch}`,
        ])) !== head
      )
        throw new Error("Candidate commit is not retained");
      await git(repo.sourcePath, [
        "worktree",
        "remove",
        "--force",
        repo.worktreePath,
      ]);
      if (repo.kind === "submodule")
        mkdirSync(repo.worktreePath, { recursive: true });
    }
    repo.status = "cleaned";
    store.saveEnvironment(environment);
  }
  environment.status = "cleaned";
  store.saveEnvironment(environment);
}
