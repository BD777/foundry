/**
 * Shared utility functions for the daemon.
 * Pure functions with no cli.ts dependencies.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AgentSession } from "@foundry/protocol";

export function readOptionalText(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

export function yamlScalar(
  text: string | undefined,
  key: string,
): string | undefined {
  if (!text) {
    return undefined;
  }
  const pattern = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m");
  const match = pattern.exec(text);
  return match?.[1]?.replace(/^["']|["']$/g, "");
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
  for (const candidate of claudeCommandCandidates()) {
    const result = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.status === 0) {
      return candidate;
    }
  }
  throw new Error(
    "Claude Code CLI is not available on PATH or in common install locations",
  );
}

/**
 * Candidate Codex CLI locations, in priority order. The ChatGPT desktop app
 * ships the CLI inside its bundle, which is the only copy on many machines, so
 * every lookup has to share this list rather than keep its own.
 */
export function codexCommandCandidates(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    env.FOUNDRY_CODEX_BIN,
    env.CODEX_CLI_PATH,
    "codex",
    "/opt/homebrew/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
  ].filter((value): value is string => Boolean(value));
}

export function resolveCodexCommand(): string {
  const candidates = codexCommandCandidates();

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.status === 0) {
      return candidate;
    }
  }
  throw new Error(
    "Codex CLI is not available on PATH or in /Applications/Codex.app",
  );
}
