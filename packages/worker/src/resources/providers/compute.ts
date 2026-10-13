// The compute provider: commands a session of the device's owner runs on
// this device (computeOperations), by the worker itself, as the worker's
// user. Nothing runs while the owner has not allowed remote commands
// (compute-settings.ts); the server checks the same before it leases.
//
// Every operation works in one folder: a scratch folder under the state
// root (compute/<scratch>), kept across leases so a checkout and its
// installed dependencies stay, or a workspace this worker serves (the
// server names its folder after checking the session may work in it).
// Paths stay inside that folder, links included. A command can still reach
// whatever the worker's user can: the folder bounds where it starts and
// what put_files, get_file and cleanup touch, not what it does.
//
// A lease's commands, background ones included, are stopped when the lease
// ends (reset); a session left idle is not closed, so a background job
// outlives the gap between two calls.

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import {
  appendFile,
  copyFile,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  computeBackend,
  type ResourceAction,
  type ResourceActionResult,
  type ResourceSourceSettings,
} from "@bd777/foundry-protocol";
import { foundryStatePath } from "../../state-root.js";
import { ArchiveError, unpackArchive, type ArchiveFormat } from "../archive.js";
import { resourceSettings } from "../compute-settings.js";
import { execBounded, findOnPath } from "../exec.js";
import {
  ProviderError,
  type ProviderLease,
  type ProviderSession,
  type ResourceProvider,
} from "../provider.js";

export const defaultRunSeconds = 600;
export const maxRunSeconds = 1800;
export const defaultTailBytes = 32 * 1024;
export const maxTailBytes = 128 * 1024;
export const maxUploadBytes = 50 * 1024 * 1024;
export const maxGetFileBytes = 25 * 1024 * 1024;
/** A run's whole time, a git_sync's, and the slack a request gets. */
export const maxComputeDeadlineMs = (maxRunSeconds + 60) * 1000;
const gitTimeoutMs = 14 * 60_000;
/** After SIGTERM, a command gets this long before SIGKILL. */
const killGraceMs = 5000;
/** After a command exits, its output is read this much longer. */
const outputDrainMs = 1000;

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const refPattern = /^[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,199}$/;

export interface ComputeProviderOptions {
  /** Where scratch folders live (default: the state root's compute/). */
  root?: string;
  settings?: () => ResourceSourceSettings;
  /** Folders of the workspaces this worker serves now. */
  workspacePaths?: () => string[];
  /** The environment commands start from. */
  env?: () => NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface ComputeProvider extends ResourceProvider {
  /** Stops every command of every lease (remote commands turned off). */
  stopAll(): Promise<void>;
}

interface Folder {
  /** Its real path. */
  base: string;
  /** How results name it: "scratch default", "workspace ws_…". */
  label: string;
}

export function createComputeProvider(
  options: ComputeProviderOptions = {},
): ComputeProvider {
  const root = options.root ?? foundryStatePath("compute");
  const settings = options.settings ?? (() => resourceSettings.get());
  const sessions = new Set<ComputeSession>();
  const context: ComputeContext = {
    root,
    platform: options.platform ?? process.platform,
    workspacePaths: options.workspacePaths ?? (() => []),
    env: options.env ?? (() => process.env),
  };
  return {
    id: computeBackend,
    type: "compute",
    platforms: ["darwin", "linux", "win32"],
    maxDeadlineMs: maxComputeDeadlineMs,
    idleCloseMs: 0,
    async open(_key, lease) {
      if (!settings().allowRemoteCommands) throw remoteCommandsOff();
      const session = new ComputeSession(context, lease, settings, () =>
        sessions.delete(session),
      );
      sessions.add(session);
      return session;
    },
    async stopAll() {
      await Promise.all([...sessions].map((session) => session.stop()));
    },
  };
}

interface ComputeContext {
  root: string;
  platform: NodeJS.Platform;
  workspacePaths: () => string[];
  env: () => NodeJS.ProcessEnv;
}

function remoteCommandsOff(): ProviderError {
  return new ProviderError(
    "remote_commands_off",
    "the device's owner has not allowed remote commands on this device",
  );
}

class ComputeSession implements ProviderSession {
  alive = true;
  /** Process groups (or processes on Windows) this lease started. */
  private readonly started = new Set<ChildProcess>();
  private readonly uploads = new Set<string>();

  constructor(
    private readonly context: ComputeContext,
    private readonly lease: ProviderLease,
    private readonly settings: () => ResourceSourceSettings,
    private readonly closed: () => void,
  ) {}

  async invoke(
    action: ResourceAction,
    signal: AbortSignal,
  ): Promise<ResourceActionResult> {
    try {
      if (!this.settings().allowRemoteCommands) throw remoteCommandsOff();
      const args = action.args ?? {};
      switch (action.op) {
        case "run":
          return await this.run(args, signal);
        case "put_files":
          return await this.putFiles(args);
        case "get_file":
          return await this.getFile(args);
        case "git_sync":
          return await this.gitSync(args, signal);
        case "cleanup":
          return await this.cleanup(args);
        default:
          throw new ProviderError(
            "backend_unsupported",
            `compute has no operation ${action.op}`,
          );
      }
    } catch (error) {
      return failure(action.op, error);
    }
  }

  async reset(): Promise<void> {
    await this.stop();
  }

  async close(): Promise<void> {
    await this.stop();
    this.alive = false;
    this.closed();
  }

  /** Stops this lease's commands and drops its unfinished uploads. */
  async stop(): Promise<void> {
    for (const child of this.started) killTree(child, "SIGKILL");
    this.started.clear();
    await Promise.all(
      [...this.uploads].map((path) => rm(path, { force: true })),
    );
    this.uploads.clear();
  }

  // --- run --------------------------------------------------------------

  private async run(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ResourceActionResult> {
    const folder = await this.folder(args);
    const cwd = await inside(folder.base, args.cwd, "cwd");
    if (!(await stat(cwd).catch(() => undefined))?.isDirectory())
      throw new ProviderError(
        "invalid_args",
        `cwd ${display(folder, cwd)} is not a folder`,
      );
    const { command, params, verbatim } = this.commandLine(args);
    const timeoutSec = boundedNumber(
      args.timeoutSec,
      defaultRunSeconds,
      1,
      maxRunSeconds,
      "timeoutSec",
    );
    const tailBytes = boundedNumber(
      args.tailBytes,
      defaultTailBytes,
      0,
      maxTailBytes,
      "tailBytes",
    );
    const env = {
      ...this.context.env(),
      ...extraEnv(args.env),
      FOUNDRY_COMPUTE_FOLDER: folder.base,
      FOUNDRY_COMPUTE_LEASE: this.lease.id,
    };
    let saved: { path: string; stream: WriteStream } | undefined;
    if (args.saveOutput !== undefined) {
      const path = await inside(folder.base, args.saveOutput, "saveOutput");
      await mkdir(dirname(path), { recursive: true });
      saved = { path, stream: createWriteStream(path) };
    }
    const started = Date.now();
    const group = this.context.platform !== "win32";
    const child = spawn(command, params, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: group,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });
    this.started.add(child);
    const stdout = new Tail(tailBytes);
    const stderr = new Tail(tailBytes);
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      saved?.stream.write(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      saved?.stream.write(chunk);
    });
    let timedOut = false;
    let stopped: ProviderError | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM");
      setTimeout(() => killTree(child, "SIGKILL"), killGraceMs).unref();
    }, timeoutSec * 1000);
    timer.unref();
    const onAbort = (): void => {
      stopped =
        signal.reason instanceof ProviderError
          ? signal.reason
          : new ProviderError("aborted", "the run was stopped");
      killTree(child, "SIGKILL");
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const exit = await new Promise<
      { code: number | null; signal: NodeJS.Signals | null } | Error
    >((settle) => {
      child.once("error", settle);
      child.once("exit", (code, exitSignal) => {
        // A background job the command left holding its output would keep
        // the pipes open: read what is there, then stop reading.
        const done = (): void => settle({ code, signal: exitSignal });
        const cutoff = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          done();
        }, outputDrainMs);
        child.once("close", () => {
          clearTimeout(cutoff);
          done();
        });
      });
    });
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    // The group stays known while background jobs it left may run; only a
    // command that never started is forgotten.
    if (exit instanceof Error) this.started.delete(child);
    if (saved) await new Promise<void>((done) => saved!.stream.end(done));
    if (exit instanceof Error) {
      const missing = (exit as NodeJS.ErrnoException).code === "ENOENT";
      throw new ProviderError(
        missing ? "command_not_found" : "run_failed",
        missing
          ? `${command} was not found on this device's PATH`
          : exit.message,
      );
    }
    if (stopped) throw stopped;
    const durationMs = Date.now() - started;
    const outcome = {
      exitCode: exit.code,
      ...(exit.signal ? { signal: exit.signal } : {}),
      timedOut,
      durationMs,
      stdoutBytes: stdout.total,
      stderrBytes: stderr.total,
      cwd: display(folder, cwd),
    };
    return {
      op: "run",
      ok: true,
      text: JSON.stringify({
        ...outcome,
        stdout: stdout.text(),
        stderr: stderr.text(),
        ...(stdout.cut ? { stdoutCut: true } : {}),
        ...(stderr.cut ? { stderrCut: true } : {}),
        ...(saved ? { savedTo: display(folder, saved.path) } : {}),
      }),
      outcome,
    };
  }

  /** argv runs without a shell; command runs in the platform's shell. */
  private commandLine(args: Record<string, unknown>): {
    command: string;
    params: string[];
    verbatim: boolean;
  } {
    const argv = args.argv;
    const line = args.command;
    if (argv !== undefined && line !== undefined)
      throw new ProviderError("invalid_args", "give argv or command, not both");
    if (Array.isArray(argv)) {
      if (
        argv.length === 0 ||
        argv.length > 4096 ||
        !argv.every((word) => typeof word === "string") ||
        !argv[0]
      )
        throw new ProviderError(
          "invalid_args",
          "argv must be a list of words, the program first",
        );
      return {
        command: argv[0] as string,
        params: argv.slice(1) as string[],
        verbatim: false,
      };
    }
    if (typeof line === "string" && line.trim()) {
      if (this.context.platform === "win32")
        return {
          command: process.env.ComSpec ?? "cmd.exe",
          params: ["/d", "/s", "/c", `"${line}"`],
          verbatim: true,
        };
      return { command: "/bin/sh", params: ["-c", line], verbatim: false };
    }
    throw new ProviderError(
      "invalid_args",
      "name the command: argv (a list of words) or command (a shell line)",
    );
  }

  // --- files ------------------------------------------------------------

  private async putFiles(
    args: Record<string, unknown>,
  ): Promise<ResourceActionResult> {
    const upload = name(args.upload, "upload");
    const folder = await this.folder(args);
    const format = uploadFormat(args.format);
    const offset = boundedNumber(args.offset, 0, 0, maxUploadBytes, "offset");
    if (typeof args.data !== "string")
      throw new ProviderError(
        "invalid_args",
        "data must be base64 text (it may be empty)",
      );
    const piece = Buffer.from(args.data, "base64");
    const staging = join(
      this.context.root,
      ".uploads",
      `${this.lease.id}-${upload}`,
    );
    await mkdir(dirname(staging), { recursive: true, mode: 0o700 });
    this.uploads.add(staging);
    if (offset === 0) await rm(staging, { force: true });
    const received = (await stat(staging).catch(() => undefined))?.size ?? 0;
    if (offset !== received)
      return {
        op: "put_files",
        ok: false,
        errorCode: "upload_offset",
        error: `this upload has ${received} bytes; send the piece at offset ${received}`,
        text: JSON.stringify({ upload, received }),
      };
    if (received + piece.length > maxUploadBytes)
      throw new ProviderError(
        "too_large",
        `an upload is at most ${maxUploadBytes} bytes`,
      );
    await appendFile(staging, piece, { mode: 0o600 });
    const total = received + piece.length;
    if (args.done !== true)
      return {
        op: "put_files",
        ok: true,
        text: JSON.stringify({ upload, received: total }),
      };
    try {
      if (format === "file") {
        if (typeof args.dest !== "string" || !args.dest)
          throw new ProviderError(
            "invalid_args",
            "dest names the file to write",
          );
        const target = await inside(folder.base, args.dest, "dest");
        await mkdir(dirname(target), { recursive: true });
        await moveFile(staging, target);
        return {
          op: "put_files",
          ok: true,
          text: JSON.stringify({
            upload,
            bytes: total,
            files: 1,
            dest: display(folder, target),
          }),
          outcome: { bytes: total, files: 1 },
        };
      }
      const dest = await inside(folder.base, args.dest, "dest");
      await mkdir(dest, { recursive: true });
      const files = await unpackArchive(await readFile(staging), format, dest);
      return {
        op: "put_files",
        ok: true,
        text: JSON.stringify({
          upload,
          bytes: total,
          files,
          dest: display(folder, dest),
        }),
        outcome: { bytes: total, files },
      };
    } catch (error) {
      if (error instanceof ArchiveError)
        throw new ProviderError("bad_archive", error.message);
      throw error;
    } finally {
      await rm(staging, { force: true });
      this.uploads.delete(staging);
    }
  }

  private async getFile(
    args: Record<string, unknown>,
  ): Promise<ResourceActionResult> {
    const folder = await this.folder(args);
    if (typeof args.path !== "string" || !args.path)
      throw new ProviderError("invalid_args", "path names the file to read");
    const path = await inside(folder.base, args.path, "path");
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile())
      throw new ProviderError(
        "not_found",
        `${display(folder, path)} is not a file`,
      );
    const offset = boundedNumber(
      args.offset,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
      "offset",
    );
    const wanted = boundedNumber(
      args.length,
      maxGetFileBytes,
      0,
      maxGetFileBytes,
      "length",
    );
    const length = Math.max(0, Math.min(wanted, info.size - offset));
    const data = Buffer.alloc(length);
    const handle = await open(path, "r");
    try {
      await handle.read(data, 0, length, offset);
    } finally {
      await handle.close();
    }
    return {
      op: "get_file",
      ok: true,
      text: JSON.stringify({
        path: display(folder, path),
        size: info.size,
        offset,
        length,
        truncated: offset + length < info.size,
        data: data.toString("base64"),
      }),
      outcome: { bytes: length },
    };
  }

  private async cleanup(
    args: Record<string, unknown>,
  ): Promise<ResourceActionResult> {
    if (args.workspacePath !== undefined || args.workspaceId !== undefined)
      throw new ProviderError(
        "invalid_args",
        "cleanup deletes in scratch folders only, never in a workspace",
      );
    const scratch = name(args.scratch ?? "default", "scratch");
    const base = join(this.context.root, scratch);
    if (!(await stat(base).catch(() => undefined)))
      return {
        op: "cleanup",
        ok: true,
        text: JSON.stringify({ removed: null }),
      };
    const real = await realpath(base);
    const target =
      args.path === undefined ? real : await inside(real, args.path, "path");
    await rm(target, { recursive: true, force: true });
    return {
      op: "cleanup",
      ok: true,
      text: JSON.stringify({
        removed: display({ base: real, label: `scratch ${scratch}` }, target),
      }),
    };
  }

  // --- git --------------------------------------------------------------

  private async gitSync(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ResourceActionResult> {
    const folder = await this.folder(args);
    const url = remoteURL(args.url);
    const ref = args.ref === undefined ? undefined : gitRef(args.ref);
    const dir = await inside(folder.base, args.dir ?? "repo", "dir");
    const env: NodeJS.ProcessEnv = {
      ...this.context.env(),
      GIT_TERMINAL_PROMPT: "0",
    };
    const git = findOnPath("git", env, this.context.platform);
    if (!git)
      throw new ProviderError(
        "command_not_found",
        "git is not installed on this device",
      );
    const step = async (gitArgs: string[]): Promise<string> => {
      const result = await execBounded(git, gitArgs, {
        env,
        signal,
        timeoutMs: gitTimeoutMs,
      });
      if (signal.aborted)
        throw new ProviderError("aborted", "git_sync was stopped");
      if (result.code !== 0)
        throw new ProviderError(
          "git_failed",
          `git ${gitArgs.filter((word) => word !== dir).join(" ")}: ${(result.stderr || result.stdout).trim().slice(-2000)}`,
        );
      return result.stdout.trim();
    };
    const fresh = !(await stat(join(dir, ".git")).catch(() => undefined));
    if (fresh) {
      await mkdir(dirname(dir), { recursive: true });
      await step(["clone", "--no-checkout", "--", url, dir]);
    } else {
      await step(["-C", dir, "remote", "set-url", "origin", url]);
    }
    let target = "origin/HEAD";
    if (ref) {
      try {
        await step(["-C", dir, "fetch", "--prune", "--tags", "origin", ref]);
        target = "FETCH_HEAD";
      } catch {
        // A commit the remote will not hand out by id: fetch everything.
        await step(["-C", dir, "fetch", "--prune", "--tags", "origin"]);
        target = await step([
          "-C",
          dir,
          "rev-parse",
          "--verify",
          `${ref}^{commit}`,
        ]).catch(() =>
          step(["-C", dir, "rev-parse", "--verify", `origin/${ref}^{commit}`]),
        );
      }
    } else if (!fresh) {
      await step(["-C", dir, "fetch", "--prune", "--tags", "origin"]);
    }
    await step(["-C", dir, "checkout", "--force", "--detach", target]);
    // Untracked files go (an earlier patch's); ignored ones stay (installs).
    await step(["-C", dir, "clean", "-fd"]);
    const head = await step(["-C", dir, "rev-parse", "HEAD"]);
    return {
      op: "git_sync",
      ok: true,
      text: JSON.stringify({
        dir: display(folder, dir),
        head,
        ref: ref ?? null,
        cloned: fresh,
      }),
      outcome: { head, cloned: fresh },
    };
  }

  // --- where ------------------------------------------------------------

  /**
   * The folder an action works in: the workspace folder the server named
   * (only one this worker serves), or a scratch folder.
   */
  private async folder(args: Record<string, unknown>): Promise<Folder> {
    if (typeof args.workspacePath === "string" && args.workspacePath) {
      if (args.scratch !== undefined)
        throw new ProviderError(
          "invalid_args",
          "name scratch or workspaceId, not both",
        );
      const wanted = resolve(args.workspacePath);
      const served = this.context.workspacePaths().map((path) => resolve(path));
      if (!served.includes(wanted))
        throw new ProviderError(
          "workspace_not_served",
          "this device does not serve that workspace's folder now",
        );
      return {
        base: await realpath(wanted),
        label: `workspace ${String(args.workspaceId ?? "")}`.trim(),
      };
    }
    if (args.workspaceId !== undefined)
      throw new ProviderError(
        "invalid_args",
        "the server did not name that workspace's folder",
      );
    const scratch = name(args.scratch ?? "default", "scratch");
    const base = join(this.context.root, scratch);
    await mkdir(base, { recursive: true, mode: 0o700 });
    return { base: await realpath(base), label: `scratch ${scratch}` };
  }
}

/**
 * A path inside base (relative, "." by default), refused when it leaves
 * base, also through a link: the nearest part of it that exists must be
 * inside base.
 */
export async function inside(
  base: string,
  value: unknown,
  what: string,
): Promise<string> {
  const path = value === undefined || value === "" ? "." : value;
  if (typeof path !== "string")
    throw new ProviderError("invalid_args", `${what} must be a relative path`);
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path))
    throw new ProviderError(
      "path_outside",
      `${what} must be relative to the folder, not ${path}`,
    );
  const target = resolve(base, path);
  if (!within(base, target))
    throw new ProviderError(
      "path_outside",
      `${what} ${path} leaves the folder`,
    );
  let probe = target;
  for (;;) {
    const real = await realpath(probe).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (real !== undefined) {
      if (!within(base, real))
        throw new ProviderError(
          "path_outside",
          `${what} ${path} leads out of the folder through a link`,
        );
      return target;
    }
    const parent = dirname(probe);
    if (parent === probe) return target;
    probe = parent;
  }
}

function within(base: string, path: string): boolean {
  return (
    path === base || path.startsWith(base.endsWith(sep) ? base : base + sep)
  );
}

function display(folder: Folder, path: string): string {
  const rest = relative(folder.base, path).split(sep).join("/");
  return rest ? `${folder.label}: ${rest}` : folder.label;
}

function name(value: unknown, what: string): string {
  if (typeof value !== "string" || !namePattern.test(value))
    throw new ProviderError(
      "invalid_args",
      `${what} must be a name of letters, digits, ".", "_" or "-" (at most 64)`,
    );
  return value;
}

function boundedNumber(
  value: unknown,
  fallback: number,
  low: number,
  high: number,
  what: string,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < low)
    throw new ProviderError(
      "invalid_args",
      `${what} must be a number of at least ${low}`,
    );
  return Math.min(Math.floor(value), high);
}

function extraEnv(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProviderError(
      "invalid_args",
      "env must be an object of names and string values",
    );
  const entries = Object.entries(value);
  if (entries.length > 64)
    throw new ProviderError("invalid_args", "env takes at most 64 names");
  const env: Record<string, string> = {};
  for (const [key, text] of entries) {
    if (!envNamePattern.test(key) || typeof text !== "string")
      throw new ProviderError(
        "invalid_args",
        `env ${key} must be a variable name with a string value`,
      );
    env[key] = text;
  }
  return env;
}

function uploadFormat(value: unknown): ArchiveFormat | "file" {
  switch (value ?? "tar") {
    case "tar":
      return "tar";
    case "tar.gz":
    case "tgz":
      return "tar.gz";
    case "zip":
      return "zip";
    case "file":
      return "file";
    default:
      throw new ProviderError(
        "invalid_args",
        "format is tar, tar.gz, zip or file",
      );
  }
}

/** Only https remotes, without credentials in them. */
function remoteURL(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new ProviderError("invalid_args", "url must be an https git remote");
  }
  if (url.protocol !== "https:")
    throw new ProviderError("invalid_args", "url must be an https git remote");
  if (url.username || url.password)
    throw new ProviderError("invalid_args", "put no credentials in the url");
  return url.toString();
}

function gitRef(value: unknown): string {
  if (
    typeof value !== "string" ||
    !refPattern.test(value) ||
    value.includes("..")
  )
    throw new ProviderError(
      "invalid_args",
      "ref must be a branch, tag or commit",
    );
  return value;
}

async function moveFile(from: string, to: string): Promise<void> {
  await rm(to, { force: true, recursive: false }).catch(() => undefined);
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(from, to);
    await unlink(from);
  }
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid)
      process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // Already gone.
  }
}

function failure(op: string, error: unknown): ResourceActionResult {
  if (error instanceof ProviderError)
    return { op, ok: false, errorCode: error.code, error: error.message };
  return {
    op,
    ok: false,
    errorCode: "compute_error",
    error: error instanceof Error ? error.message : String(error),
  };
}

/** The last bytes of a stream, and how many there were in all. */
class Tail {
  private chunks: Buffer[] = [];
  private kept = 0;
  total = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.limit === 0) return;
    this.chunks.push(chunk);
    this.kept += chunk.length;
    if (this.kept > this.limit * 2) {
      const joined = Buffer.concat(this.chunks);
      const last = joined.subarray(joined.length - this.limit);
      this.chunks = [last];
      this.kept = last.length;
    }
  }

  get cut(): boolean {
    return this.total > this.limit;
  }

  text(): string {
    const joined = Buffer.concat(this.chunks);
    return joined
      .subarray(Math.max(0, joined.length - this.limit))
      .toString("utf8");
  }
}
