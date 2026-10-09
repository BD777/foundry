/**
 * Shared utility functions for the daemon.
 * Pure functions with no cli.ts dependencies.
 */

import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AgentSession } from "@bd777/foundry-protocol";

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
 * Kill a child process with SIGTERM, escalating to SIGKILL after
 * `timeoutMs` if the process ignores the termination signal.
 */
export function killChildProcess(
  child: import("node:child_process").ChildProcess,
  timeoutMs = 5000,
): void {
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
  }, timeoutMs);
  timer.unref();
}

/**
 * Hand a child its prompt on stdin. A command may exit without reading it;
 * its exit status, reported on close, is then the outcome, so a closed pipe
 * is not an error of its own. Any other stdin failure stops the child.
 */
export function sendPrompt(
  child: import("node:child_process").ChildProcess,
  prompt: string,
): void {
  child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") killChildProcess(child);
  });
  child.stdin?.end(prompt);
}

export function isDiagnosticSession(session: AgentSession): boolean {
  return session.source === "diagnostic";
}

export function isUtilitySession(session: AgentSession): boolean {
  return (
    isDiagnosticSession(session) ||
    session.source === "naming" ||
    session.source === "verification"
  );
}

/**
 * Candidate Claude Code CLI locations, in priority order. The native
 * installer puts the CLI in `~/.local/bin/claude`, which launchd-managed
 * daemons do not inherit through PATH, so it is probed explicitly.
 */
export function claudeCommandCandidates(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  return [
    env.FOUNDRY_CLAUDE_BIN,
    "claude",
    resolve(home, ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
  ].filter((value): value is string => Boolean(value));
}

export function resolveClaudeCommand(): string {
  const found = resolveDeviceCommand(claudeCommandCandidates());
  if (!found)
    throw new Error(
      "Claude Code CLI is not available on PATH or in common install locations",
    );
  return found.command;
}

/**
 * Candidate Codex CLI locations, in priority order. The ChatGPT desktop app
 * ships the CLI inside its bundle, which is the only copy on many machines, so
 * every lookup has to share this list rather than keep its own.
 */
export function codexCommandCandidates(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  return [
    env.FOUNDRY_CODEX_BIN,
    env.CODEX_CLI_PATH,
    "codex",
    resolve(home, ".local/bin/codex"),
    "/opt/homebrew/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
  ].filter((value): value is string => Boolean(value));
}

export function resolveCodexCommand(): string {
  const found = resolveDeviceCommand(codexCommandCandidates());
  if (!found)
    throw new Error(
      "Codex CLI is not available on PATH or in common install locations",
    );
  return found.command;
}

/** A device program that runs, and what its `--version` printed. */
export interface DeviceCommand {
  command: string;
  versionOutput: string;
}

const deviceCommands = new Map<
  string,
  { until: number; found: DeviceCommand | undefined }
>();

/**
 * The first candidate that runs `--version`. Every lookup of the device's
 * Claude Code and Codex goes through here, so they all agree on which program
 * Foundry runs; the answer is kept for a minute because each probe starts the
 * program. Only the first lookup waits for the probe: an older answer is
 * returned while a fresh one is probed in the background, because a blocking
 * probe of a slow program at every registration kept the worker from
 * answering the server.
 */
export function resolveDeviceCommand(
  candidates: string[],
): DeviceCommand | undefined {
  const key = JSON.stringify([candidates, process.env.PATH]);
  const cached = deviceCommands.get(key);
  if (cached && cached.until > Date.now()) return cached.found;
  if (cached) {
    refreshDeviceCommand(key, candidates);
    return cached.found;
  }
  let found: DeviceCommand | undefined;
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 10_000,
    });
    if (result.status === 0) {
      found = {
        command: candidate,
        versionOutput: `${result.stdout ?? ""}${result.stderr ?? ""}`,
      };
      break;
    }
  }
  deviceCommands.set(key, { until: Date.now() + 60_000, found });
  return found;
}

const refreshing = new Set<string>();
let deviceCommandsGeneration = 0;

function probeVersion(candidate: string): Promise<DeviceCommand | undefined> {
  return new Promise((resolveProbe) => {
    execFile(
      candidate,
      ["--version"],
      { encoding: "utf8", timeout: 10_000 },
      (error, stdout, stderr) =>
        resolveProbe(
          error
            ? undefined
            : { command: candidate, versionOutput: `${stdout}${stderr}` },
        ),
    );
  });
}

function refreshDeviceCommand(key: string, candidates: string[]): void {
  if (refreshing.has(key)) return;
  refreshing.add(key);
  const generation = deviceCommandsGeneration;
  void (async () => {
    let found: DeviceCommand | undefined;
    for (const candidate of candidates) {
      found = await probeVersion(candidate);
      if (found) break;
    }
    // A clear while probing (an install or update) makes this answer stale.
    if (generation === deviceCommandsGeneration)
      deviceCommands.set(key, { until: Date.now() + 60_000, found });
  })().finally(() => refreshing.delete(key));
}

export function clearDeviceCommands(): void {
  deviceCommandsGeneration += 1;
  deviceCommands.clear();
}
