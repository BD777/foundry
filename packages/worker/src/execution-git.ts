import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function git(
  cwd: string,
  args: string[],
  input?: {
    optional?: boolean;
    env?: NodeJS.ProcessEnv;
    /**
     * Work that grows with the size of the workspace (listing, staging or
     * committing every file): no time limit and room for long output.
     */
    bulk?: boolean;
  },
): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...input?.env,
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ])
    delete env[key];
  try {
    const result = await exec(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "maintenance.auto=false",
        "-C",
        cwd,
        ...args,
      ],
      input?.bulk
        ? { env, maxBuffer: 1024 * 1024 * 1024, timeout: 0 }
        : { env, maxBuffer: 32 * 1024 * 1024, timeout: 60_000 },
    );
    return result.stdout.trimEnd();
  } catch (error) {
    if (input?.optional) return "";
    const detail = error as Error & { stderr?: string; stdout?: string };
    throw new Error(
      `git ${args[0]}: ${detail.stderr?.trim() || detail.stdout?.trim() || detail.message}`,
    );
  }
}

export const commitIdentity = {
  GIT_AUTHOR_NAME: "Foundry",
  GIT_AUTHOR_EMAIL: "foundry@localhost",
  GIT_COMMITTER_NAME: "Foundry",
  GIT_COMMITTER_EMAIL: "foundry@localhost",
};

export async function gitCommit(
  cwd: string,
  message: string,
  options: { bulk?: boolean } = {},
): Promise<string> {
  if (
    (await git(cwd, ["diff", "--cached", "--name-only"], options)) ||
    (await git(cwd, ["rev-parse", "--quiet", "--verify", "MERGE_HEAD"], {
      optional: true,
    }))
  ) {
    await git(cwd, ["commit", "-m", message], {
      env: commitIdentity,
      bulk: options.bulk,
    });
  }
  return git(cwd, ["rev-parse", "HEAD"]);
}

/**
 * Foundry's runtime data under a workspace's `.foundry/`: never the person's
 * to commit. Shared configuration there (`skills.yaml`, `preview.json`, …)
 * stays visible to Git.
 */
export const foundryRuntimeGitExcludes = [
  ".foundry/sessions/",
  ".foundry/attachments/",
  ".foundry/runs/",
  ".foundry/worktrees/",
  ".foundry/issues/",
  ".foundry/reviews/",
  ".foundry/integrations/",
  ".foundry/daemon.json",
];

const excludedWorkspaces = new Set<string>();
const excludesInProgress = new Map<string, Promise<boolean>>();

/**
 * Keeps a workspace's Foundry runtime data out of its repository through the
 * repository's local excludes (`info/exclude`, worktree-aware), never a
 * committed `.gitignore`. Idempotent, and checked once per process; outside
 * a Git work tree it does nothing and reports false, so a later `git init`
 * is still handled.
 */
export function excludeFoundryRuntimeFromGit(
  workspacePath: string,
): Promise<boolean> {
  if (excludedWorkspaces.has(workspacePath)) return Promise.resolve(true);
  const running = excludesInProgress.get(workspacePath);
  if (running) return running;
  const work = (async () => {
    const prefix = await git(workspacePath, ["rev-parse", "--show-prefix"], {
      optional: true,
    });
    const exclude = await git(
      workspacePath,
      ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
      { optional: true },
    );
    if (!exclude) return false;
    const anchor = `/${prefix.replace(/[\\*?[\]#! ]/g, "\\$&")}`;
    const existing = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    const lines = existing.split("\n");
    const added = foundryRuntimeGitExcludes
      .map((entry) => `${anchor}${entry}`)
      .filter((entry) => !lines.includes(entry));
    if (added.length) {
      mkdirSync(dirname(exclude), { recursive: true });
      const separator = existing && !existing.endsWith("\n") ? "\n" : "";
      writeFileSync(exclude, `${existing}${separator}${added.join("\n")}\n`);
    }
    excludedWorkspaces.add(workspacePath);
    return true;
  })().finally(() => excludesInProgress.delete(workspacePath));
  excludesInProgress.set(workspacePath, work);
  return work;
}
