/**
 * What an update the server asked for is doing. The update command writes a
 * small file at each step and when it ends; the daemon reads it to answer the
 * server's status probes and to report a failure. Being a file, it outlives
 * the daemon restarting midway.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { WorkerUpdateStep } from "@bd777/foundry-protocol";
import { redactSecrets } from "./secret-redaction.js";
import { foundryStatePath } from "./state-root.js";

export type SelfUpdateStep = WorkerUpdateStep;

export interface SelfUpdateRecord {
  state: "running" | "failed" | "succeeded";
  step: SelfUpdateStep;
  startedAt: string;
  updatedAt: string;
  /** The update command's process; absent until it runs (systemd starts it). */
  pid?: number;
  /** The version it installs, once known. */
  version?: string;
  /** What the step is waiting on, e.g. a retry. */
  detail?: string;
  exitCode?: number;
  error?: string;
}

/** The answer to the server's `read_worker_update_status`. */
export interface WorkerUpdateStatus {
  /** `none`: no update is running and none left an outcome. */
  state: "running" | "failed" | "succeeded" | "none";
  startedAt?: string;
  step?: SelfUpdateStep;
  version?: string;
  detail?: string;
  elapsedMs?: number;
  exitCode?: number;
  error?: string;
  /** The end of this update's log, secrets redacted. */
  logTail?: string[];
}

/**
 * The update command learns where to record its progress from this variable,
 * set by the daemon that started it; an update run by hand records nothing.
 */
export const selfUpdateStatusVariable = "FOUNDRY_SELF_UPDATE_STATUS";

/** How long an update may take to start writing its own progress. */
const startGraceMs = 60_000;
const logTailLines = 20;
const logTailBytes = 64 * 1024;

export const selfUpdateStatusPath = () =>
  foundryStatePath("logs", "self-update-status.json");

export const selfUpdateLogPath = () =>
  foundryStatePath("logs", "self-update.log");

/** Starts each requested update's part of the log; the tail begins there. */
export const selfUpdateLogMarker = "=== Update requested by the server at ";

export function readSelfUpdateRecord(
  path = selfUpdateStatusPath(),
): SelfUpdateRecord | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SelfUpdateRecord;
  } catch {
    return undefined;
  }
}

export function writeSelfUpdateRecord(
  record: SelfUpdateRecord,
  path = selfUpdateStatusPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  const next = `${path}.${process.pid}`;
  writeFileSync(next, JSON.stringify(record));
  renameSync(next, path);
}

/** The update command records a step, when a daemon asked for the update. */
export function recordSelfUpdateStep(
  step: SelfUpdateStep,
  fields: { version?: string; detail?: string } = {},
): void {
  const path = process.env[selfUpdateStatusVariable];
  if (!path) return;
  const previous = readSelfUpdateRecord(path);
  const now = new Date().toISOString();
  writeSelfUpdateRecord(
    {
      state: "running",
      step,
      startedAt: previous?.startedAt ?? now,
      updatedAt: now,
      pid: process.pid,
      version: fields.version ?? previous?.version,
      detail: fields.detail,
    },
    path,
  );
}

/**
 * The update command records how it ended. A run that handed the update to
 * another build keeps that build's failure, which says more than its exit.
 */
export function recordSelfUpdateEnd(
  outcome: { ok: true } | { ok: false; exitCode: number; error: string },
): void {
  const path = process.env[selfUpdateStatusVariable];
  if (!path) return;
  const previous = readSelfUpdateRecord(path);
  if (!outcome.ok && previous?.state === "failed") return;
  const now = new Date().toISOString();
  writeSelfUpdateRecord(
    {
      state: outcome.ok ? "succeeded" : "failed",
      step: previous?.step ?? "starting",
      startedAt: previous?.startedAt ?? now,
      updatedAt: now,
      pid: process.pid,
      version: previous?.version,
      ...(outcome.ok
        ? {}
        : { exitCode: outcome.exitCode, error: outcome.error }),
    },
    path,
  );
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The last lines this update wrote to its log, secrets redacted. */
export function selfUpdateLogTail(log = selfUpdateLogPath()): string[] {
  let text: string;
  try {
    const size = statSync(log).size;
    const length = Math.min(size, logTailBytes);
    const buffer = Buffer.alloc(length);
    const fd = openSync(log, "r");
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    text = buffer.toString("utf8");
  } catch {
    return [];
  }
  const marker = text.lastIndexOf(selfUpdateLogMarker);
  if (marker >= 0) text = text.slice(text.indexOf("\n", marker) + 1);
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-logTailLines)
    .map((line) =>
      redactSecrets(line)
        .replace(/(--token[ =])\S+/g, "$1[REDACTED]")
        .slice(0, 500),
    );
}

/** What the daemon tells the server about the update it started. */
export function readWorkerUpdateStatus(
  now = Date.now(),
  path = selfUpdateStatusPath(),
  log = selfUpdateLogPath(),
): WorkerUpdateStatus {
  const record = readSelfUpdateRecord(path);
  if (!record) return { state: "none" };
  const common = {
    startedAt: record.startedAt,
    step: record.step,
    version: record.version,
    elapsedMs: Math.max(0, now - Date.parse(record.startedAt)),
  };
  if (record.state === "failed")
    return {
      ...common,
      state: "failed",
      exitCode: record.exitCode,
      error: record.error,
      logTail: selfUpdateLogTail(log),
    };
  if (record.state === "succeeded") return { ...common, state: "succeeded" };
  const alive =
    record.pid === undefined
      ? now - Date.parse(record.updatedAt) < startGraceMs
      : processAlive(record.pid);
  return alive
    ? { ...common, state: "running", detail: record.detail }
    : { ...common, state: "none", logTail: selfUpdateLogTail(log) };
}
