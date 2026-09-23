import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function git(
  cwd: string,
  args: string[],
  input?: { optional?: boolean; env?: NodeJS.ProcessEnv },
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
      { env, maxBuffer: 32 * 1024 * 1024, timeout: 60_000 },
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

export async function gitCommit(cwd: string, message: string): Promise<string> {
  if (
    (await git(cwd, ["diff", "--cached", "--name-only"])) ||
    (await git(cwd, ["rev-parse", "--quiet", "--verify", "MERGE_HEAD"], {
      optional: true,
    }))
  ) {
    await git(cwd, ["commit", "-m", message], { env: commitIdentity });
  }
  return git(cwd, ["rev-parse", "HEAD"]);
}
