/**
 * Appends lines to a log without blocking the event loop.
 *
 * A synchronous append waits for the file system on the calling thread. In a
 * workspace on a network share (SMB, 2026-11-05) each one took about 70 ms,
 * and a model streaming a large tool input logs one line per delta: the
 * execution host's loop stayed blocked past its heartbeat and was reclaimed
 * mid-turn (DEV-124). One stream per file keeps its lines in order; a stream
 * idle for a while is closed. A log that cannot be written is reported once
 * and skipped until it has been idle, never failing the caller.
 */
import { createWriteStream, type WriteStream } from "node:fs";

const idleCloseMs = 10_000;

interface LineLog {
  stream?: WriteStream;
  idle?: ReturnType<typeof setTimeout>;
}

const logs = new Map<string, LineLog>();

function close(path: string, log: LineLog): Promise<void> {
  clearTimeout(log.idle);
  if (logs.get(path) === log) logs.delete(path);
  const stream = log.stream;
  if (!stream || stream.destroyed) return Promise.resolve();
  return new Promise((done) => {
    stream.once("close", () => done());
    stream.end();
  });
}

function open(path: string, flags: "a" | "w"): LineLog {
  const stream = createWriteStream(path, { flags });
  const opened: LineLog = { stream };
  logs.set(path, opened);
  stream.once("error", (error) => {
    // Lines for it are dropped until it has been idle.
    opened.stream = undefined;
    console.error(`Could not append to ${path}: ${error.message}`);
  });
  return opened;
}

function written(path: string, log: LineLog, line: string): void {
  log.stream?.write(line);
  clearTimeout(log.idle);
  log.idle = setTimeout(() => void close(path, log), idleCloseMs);
  log.idle.unref();
}

export function appendLine(path: string, line: string): void {
  written(path, logs.get(path) ?? open(path, "a"), line);
}

/**
 * Starts the log at `path` empty, as a new run's log; lines a previous
 * stream on it had not written yet are dropped with it.
 */
export function startLines(path: string, line = ""): void {
  const previous = logs.get(path);
  if (previous) {
    clearTimeout(previous.idle);
    logs.delete(path);
    previous.stream?.destroy();
  }
  written(path, open(path, "w"), line);
}

/** Resolves once the lines appended to `path` so far are written. */
export function flushLines(path: string): Promise<void> {
  const log = logs.get(path);
  return log ? close(path, log) : Promise.resolve();
}
