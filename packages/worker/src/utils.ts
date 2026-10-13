/**
 * Shared utility functions for the daemon.
 * Pure functions with no cli.ts dependencies.
 */

import { existsSync, readFileSync } from "node:fs";
import { stopAgentProcess } from "./agent-processes.js";

export function readOptionalText(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

export function safeID(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function optionValue(
  args: string[],
  name: string,
  fallback?: string,
): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) {
    return args[index + 1];
  }
  const assignment = args.find((arg) => arg.startsWith(`${name}=`));
  if (assignment) {
    return assignment.slice(name.length + 1);
  }
  return fallback;
}

export function optionEnabled(args: string[], name: string): boolean {
  return args.includes(name);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * Hand a child its prompt on stdin. A command may exit without reading it;
 * its exit status, reported on close, is then the outcome, so a closed pipe
 * is not an error of its own. Any other stdin failure stops the child:
 * TERM, then KILL if it ignores that.
 */
export function sendPrompt(
  child: import("node:child_process").ChildProcess,
  prompt: string,
): void {
  child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") stopAgentProcess(child);
  });
  child.stdin?.end(prompt);
}

/** The message of a thrown value, whatever was thrown. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
