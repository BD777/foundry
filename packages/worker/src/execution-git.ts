import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface GitOptions {
  /** A failure answers "" instead of throwing. */
  optional?: boolean;
  env?: NodeJS.ProcessEnv;
  /**
   * Work that grows with the size of the workspace (listing, staging or
   * committing every file): no time limit and room for long output.
   */
  bulk?: boolean;
  /** Bytes of output accepted; overrides bulk's. */
  maxBuffer?: number;
  /** Milliseconds before git is stopped, 0 for none; overrides bulk's. */
  timeout?: number;
}

/**
 * Git as Foundry runs it: no hooks, signing or background maintenance, never
 * a prompt, and no repository chosen by the inherited environment.
 */
function gitInvocation(
  cwd: string,
  args: string[],
  input: GitOptions = {},
): { args: string[]; env: NodeJS.ProcessEnv } {
  const inherited: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ])
    delete inherited[key];
  return {
    args: [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "maintenance.auto=false",
      "-c",
      "gc.auto=0",
      "-C",
      cwd,
      ...args,
    ],
    env: { ...inherited, ...input.env, GIT_TERMINAL_PROMPT: "0" },
  };
}

function execOptions(input: GitOptions, env: NodeJS.ProcessEnv) {
  return {
    env,
    maxBuffer:
      input.maxBuffer ?? (input.bulk ? 1024 * 1024 * 1024 : 32 * 1024 * 1024),
    timeout: input.timeout ?? (input.bulk ? 0 : 60_000),
  };
}

function gitError(args: string[], error: unknown): Error {
  const detail = error as Error & { stderr?: unknown; stdout?: unknown };
  return new Error(
    `git ${args[0]}: ${String(detail.stderr ?? "").trim() || String(detail.stdout ?? "").trim() || detail.message}`,
  );
}

export async function git(
  cwd: string,
  args: string[],
  input: GitOptions = {},
): Promise<string> {
  const invocation = gitInvocation(cwd, args, input);
  try {
    const result = await exec(
      "git",
      invocation.args,
      execOptions(input, invocation.env),
    );
    return result.stdout.trimEnd();
  } catch (error) {
    if (input.optional) return "";
    throw gitError(args, error);
  }
}

/** git for output read as bytes, such as a blob: untrimmed, never optional. */
export async function gitBytes(
  cwd: string,
  args: string[],
  input: Omit<GitOptions, "optional"> = {},
): Promise<Buffer> {
  const invocation = gitInvocation(cwd, args, input);
  try {
    const result = await exec("git", invocation.args, {
      ...execOptions(input, invocation.env),
      encoding: "buffer",
    });
    return result.stdout;
  } catch (error) {
    throw gitError(args, error);
  }
}

/** git for synchronous callers: the outcome, never thrown. */
export function gitSync(
  cwd: string,
  args: string[],
): { ok: boolean; status: number | null; stdout: string; stderr: string } {
  const invocation = gitInvocation(cwd, args);
  const result = spawnSync("git", invocation.args, {
    env: invocation.env,
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
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
 * Everything Foundry keeps under a workspace's `.foundry/` (its identity, this
 * machine's repository list, sessions, runs) is its own and never the
 * person's to commit. The one file a person writes there themselves,
 * `preview.json`, stays visible to Git.
 */
export const foundryRuntimeGitExcludes = [
  ".foundry/*",
  "!.foundry/preview.json",
];

/** The excludes as `info/exclude` lines for a workspace at `anchor` ("/…/"). */
export function anchoredFoundryRuntimeExcludes(anchor: string): string[] {
  return foundryRuntimeGitExcludes.map((entry) =>
    entry.startsWith("!") ? `!${anchor}${entry.slice(1)}` : `${anchor}${entry}`,
  );
}

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
    const added = anchoredFoundryRuntimeExcludes(anchor).filter(
      (entry) => !lines.includes(entry),
    );
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
