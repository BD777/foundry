import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  openSync,
  closeSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { writeJSON } from "./storage.js";
import { foundryStateRoot } from "./state-root.js";
import type {
  IssueEnvironment,
  WorkspaceRegistration,
} from "./execution-types.js";

export function identifier(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new Error("Invalid execution identifier");
  return value;
}

export function within(root: string, path: string): boolean {
  const suffix = relative(resolve(root), resolve(path));
  return (
    suffix === "" ||
    (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith("../"))
  );
}

export function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(resolve(path));
  if (parent === resolve(path)) throw new Error(`Cannot resolve ${path}`);
  return resolve(canonical(parent), relative(parent, resolve(path)));
}

export function childPath(root: string, suffix: string): string {
  if (!suffix || isAbsolute(suffix) || suffix.split(/[\\/]/).includes(".."))
    throw new Error("Invalid repository path");
  const path = canonical(resolve(root, suffix));
  if (!within(canonical(root), path))
    throw new Error("Repository path escapes workspace");
  return path;
}

export async function withFileLock<T>(
  path: string,
  action: () => Promise<T>,
): Promise<T> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 30_000;
  let fd: number;
  while (true) {
    try {
      fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const pid = Number(readFileSync(path, "utf8"));
        if (pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (aliveError) {
            if ((aliveError as NodeJS.ErrnoException).code === "ESRCH") {
              unlinkSync(path);
              continue;
            }
          }
        }
      } catch {
        /* The owner may just have released the lock. */
      }
      if (Date.now() > deadline)
        throw new Error(`Execution operation is busy: ${path}`);
      await new Promise((done) => setTimeout(done, 30));
    }
  }
  try {
    return await action();
  } finally {
    closeSync(fd!);
    unlinkSync(path);
  }
}

export class ExecutionStore {
  readonly stateRoot: string;
  readonly executionRoot: string;

  constructor(stateRoot = foundryStateRoot()) {
    this.stateRoot = canonical(stateRoot);
    const configPath = resolve(this.stateRoot, "storage.local.json");
    const config = existsSync(configPath)
      ? (JSON.parse(readFileSync(configPath, "utf8")) as {
          executionRoot?: string;
        })
      : {};
    if (config.executionRoot && !isAbsolute(config.executionRoot))
      throw new Error("executionRoot must be absolute");
    this.executionRoot = canonical(
      config.executionRoot ?? resolve(this.stateRoot, "workspaces"),
    );
  }

  metadata(workspaceId: string): string {
    return resolve(this.stateRoot, "workspaces", identifier(workspaceId));
  }
  registration(workspaceId: string): WorkspaceRegistration | undefined {
    const path = resolve(this.metadata(workspaceId), "registration.local.json");
    return existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"))
      : undefined;
  }
  saveRegistration(registration: WorkspaceRegistration): void {
    writeJSON(
      resolve(
        this.metadata(registration.workspaceId),
        "registration.local.json",
      ),
      registration,
    );
  }
  environmentPath(workspaceId: string, issueId: string): string {
    const pointer = resolve(
      this.metadata(workspaceId),
      "environment-locations",
      `${identifier(issueId)}.json`,
    );
    if (existsSync(pointer))
      return JSON.parse(readFileSync(pointer, "utf8")).path;
    return resolve(
      this.executionRoot,
      identifier(workspaceId),
      "environments",
      identifier(issueId),
      "environment.json",
    );
  }
  environment(
    workspaceId: string,
    issueId: string,
  ): IssueEnvironment | undefined {
    const path = this.environmentPath(workspaceId, issueId);
    return existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"))
      : undefined;
  }
  saveEnvironment(environment: IssueEnvironment): void {
    environment.updatedAt = new Date().toISOString();
    const path = resolve(environment.directory, "environment.json");
    writeJSON(path, environment);
    writeJSON(
      resolve(
        this.metadata(environment.workspaceId),
        "environment-locations",
        `${identifier(environment.issueId)}.json`,
      ),
      { path },
    );
  }
  runDirectory(environment: IssueEnvironment, runId: string): string {
    return resolve(
      environment.directory,
      "..",
      "..",
      "runs",
      identifier(runId),
    );
  }
  lock<T>(
    workspaceId: string,
    key: string,
    action: () => Promise<T>,
  ): Promise<T> {
    return withFileLock(
      resolve(this.metadata(workspaceId), "locks", `${identifier(key)}.lock`),
      action,
    );
  }
}
