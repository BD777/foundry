// Bounded, asynchronous program runs for detectors: no shell, capped
// output, and the whole process group killed on timeout or abort, so a hung
// tool never blocks the worker's event loop or outlives its detector.

import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export interface ExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Bytes of stdout and of stderr kept; the rest is dropped. */
  maxOutputBytes?: number;
}

export interface ExecResult {
  /** The exit code; null when killed or never started. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The program does not exist. */
  missing: boolean;
}

const defaultTimeoutMs = 3000;
const defaultMaxOutputBytes = 1 << 20;

export function execBounded(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const maxOutput = options.maxOutputBytes ?? defaultMaxOutputBytes;
  return new Promise((resolveRun) => {
    if (options.signal?.aborted) {
      resolveRun({
        code: null,
        stdout: "",
        stderr: "aborted",
        timedOut: true,
        missing: false,
      });
      return;
    }
    const group = process.platform !== "win32";
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: group,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= maxOutput) return;
      stdout.push(chunk.subarray(0, maxOutput - stdoutBytes));
      stdoutBytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= maxOutput) return;
      stderr.push(chunk.subarray(0, maxOutput - stderrBytes));
      stderrBytes += chunk.length;
    });
    const kill = (): void => {
      timedOut = true;
      try {
        if (group && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(kill, options.timeoutMs ?? defaultTimeoutMs);
    timer.unref();
    options.signal?.addEventListener("abort", kill, { once: true });
    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
      resolveRun(result);
    };
    child.once("error", (error: NodeJS.ErrnoException) =>
      finish({
        code: null,
        stdout: "",
        stderr: error.message,
        timedOut: false,
        missing: error.code === "ENOENT",
      }),
    );
    child.once("close", (code) =>
      finish({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        missing: false,
      }),
    );
  });
}

/**
 * The program's path on PATH (with PATHEXT on Windows), or undefined: a
 * file check, so looking for a tool that is not there starts nothing.
 */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const extensions =
    platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")]
      : [""];
  const directories = isAbsolute(name)
    ? [""]
    : (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  for (const directory of directories)
    for (const extension of extensions) {
      const candidate = directory
        ? join(directory, name + extension)
        : name + extension;
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  return undefined;
}

export function isExecutableFile(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first line of a program's output, trimmed. */
export function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}
