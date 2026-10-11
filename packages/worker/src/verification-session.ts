// How a verifier runs (a session started with verification, to check
// another session's work): in the workspace itself, inside a sandbox that
// keeps the workspace read-only for the agent and every command it runs, so
// it can run tests, linters and git while nothing it does can change the
// work it checks. It writes only to a private scratch directory outside the
// workspace: its home, its runtime's records and the temporary directory its
// commands write to. What its runtime may call is its role
// (session-roles.ts).

import { mkdirSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentSession } from "@bd777/foundry-protocol";
import { ExecutionStore, identifier } from "./execution-storage.js";
import type { SessionAmbientEnv } from "./session-ambient.js";
import type { WorkspaceSandbox } from "./session/index.js";
import {
  isolatedAgentEnvironment,
  skillSetsReadRoot,
} from "./session/isolated-environment.js";

/** A verifier's directory unused this long is removed with its caches. */
const verifierRetentionMs = 7 * 24 * 60 * 60 * 1000;

function verificationsRoot(
  workspaceId: string,
  store = new ExecutionStore(),
): string {
  return resolve(store.executionRoot, identifier(workspaceId), "verifications");
}

/** Where a verifier keeps its private state, beside the workspace's Issues. */
export function verificationDirectory(
  workspaceId: string,
  sessionId: string,
  store = new ExecutionStore(),
): string {
  return resolve(verificationsRoot(workspaceId, store), identifier(sessionId));
}

/**
 * Where and how a verifier's turn runs. Each turn starts with an empty
 * temporary directory; its runtime's records stay, so a later message
 * continues the same native session.
 */
export function verificationExecution(
  session: AgentSession,
  workspacePath: string,
  ambient: SessionAmbientEnv,
  store = new ExecutionStore(),
): { cwd: string; stateRoot: string; sandbox: WorkspaceSandbox } {
  pruneVerifiers(session.workspaceId, store);
  const directory = verificationDirectory(
    session.workspaceId,
    session.id,
    store,
  );
  const scratch = resolve(directory, "scratch");
  rmSync(resolve(scratch, "tmp"), { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const now = new Date();
  utimesSync(directory, now, now);
  return {
    cwd: workspacePath,
    stateRoot: directory,
    sandbox: {
      profile: {
        kind: "writable_tree",
        policyFile: resolve(directory, "verification.sb"),
        workdir: workspacePath,
        readRoots: [workspacePath],
        writeRoots: [scratch],
        protectedReadRoots: [skillSetsReadRoot()],
        readOnlyDirectories: [],
        readOnlyPaths: [],
        connectSockets: [],
        executables: [],
        // Checks run the project's own toolchain, wherever the person
        // installed it; the person's files stay read-only like the rest.
        userFiles: "readable",
      },
      env: isolatedAgentEnvironment(scratch),
      stderrFile: resolve(directory, "session.stderr.log"),
      ambient,
    },
  };
}

/** Removes the workspace's verifiers that have not run for a week. */
function pruneVerifiers(workspaceId: string, store: ExecutionStore): void {
  const root = verificationsRoot(workspaceId, store);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - verifierRetentionMs;
  for (const entry of entries) {
    const path = resolve(root, entry);
    try {
      if (statSync(path).mtimeMs < cutoff)
        rmSync(path, { recursive: true, force: true });
    } catch {
      // Another turn removed or is using it; the next start tries again.
    }
  }
}

/**
 * What a verifier is told about where it runs, in place of a session's
 * device notes.
 */
export function verificationNotes(input: {
  workspacePath: string;
  sessionId: string;
  temporaryDirectory?: string;
  maxTurns?: number;
}): string {
  const temporary = input.temporaryDirectory
    ? `$TMPDIR (${input.temporaryDirectory})`
    : "$TMPDIR";
  return [
    "Foundry device notes:",
    `- You are Foundry session ${input.sessionId}, an independent verifier: you check work and report what you found; you never change it, and you start no other sessions.`,
    `- The workspace (${input.workspacePath}) is read-only at the operating-system level, for you and every command you run. Reading files and running commands that only read work: tests, linters, type checks, git status, git diff and git log. Anything that writes inside the workspace fails; do not look for a way around it.`,
    `- Commands may write only to ${temporary}, outside the workspace and emptied before each of your turns. Point tools that write there: GOCACHE=$TMPDIR/go-build, CARGO_TARGET_DIR=$TMPDIR/target, a build's output directory, or a copy of the project in $TMPDIR when a check must write next to its files.`,
    ...(input.maxTurns
      ? [
          `- You have ${input.maxTurns} turns per message: run the checks that settle the question first.`,
        ]
      : []),
    "- Report what you checked, with the commands you ran and what they printed, separately from what you could not check and why.",
    "- Ids such as sess_…, native_claude_… and ws_…, and Foundry chat links, name Foundry sessions and workspaces; the Foundry tools you have read them.",
  ].join("\n");
}
