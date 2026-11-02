// The person's assistant reads its instructions the way Claude Code and
// Codex read any project's: from its folder's AGENTS.md. Foundry sends that
// file and the worked examples beside it with each run (run_session's
// personalAgentFiles, docs/personal-agent.md §12); the worker writes them
// before the runtime starts. Nothing about the person is in them: what the
// assistant knows of them comes with each turn's input.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession, SetupWorkspaceFile } from "@bd777/foundry-protocol";
import { writeFileAtomic } from "../platform/storage.js";

/** The only files Foundry writes into the assistant's folder for a run. */
const assistantFilePath = /^(AGENTS\.md|\.foundry\/[A-Za-z0-9._-]+\.md)$/;

/** Each personal_agent session's last files, by session id. */
const revisionBySession = new Map<
  string,
  { workspaceId: string; revision: string }
>();

/**
 * Writes a personal_agent session's files into its folder, each only when
 * its content changed, and keeps their revision for the session's runtime
 * key: new instructions start a new runtime, which reads them. A run
 * without files (a timer's turn, a continuation) keeps the last revision.
 * Any other session's files are ignored.
 */
export function writePersonalAgentFiles(
  session: AgentSession,
  workspacePath: string,
  files: SetupWorkspaceFile[] | undefined,
): void {
  if (session.role !== "personal_agent" || !session.id || !files?.length)
    return;
  const revision = createHash("sha256");
  for (const file of files) {
    if (!assistantFilePath.test(file.path))
      throw new Error(
        `Foundry does not write ${file.path} into the assistant's folder`,
      );
    revision.update(`${file.path}\0${file.content}\0`);
    const target = join(workspacePath, file.path);
    if (readIfPresent(target) === file.content) continue;
    writeFileAtomic(target, file.content, {
      mode: 0o644,
      directoryMode: 0o755,
      hardenParent: false,
    });
  }
  revisionBySession.set(session.id, {
    workspaceId: session.workspaceId,
    revision: revision.digest("hex"),
  });
}

/** The revision of a session's last files; undefined for other sessions. */
export function personalAgentFilesRevision(
  sessionId: string,
): string | undefined {
  return revisionBySession.get(sessionId)?.revision;
}

/** Drops the revisions kept for a workspace's sessions (it was forgotten). */
export function forgetPersonalAgentFiles(workspaceId: string): void {
  for (const [sessionId, kept] of revisionBySession)
    if (kept.workspaceId === workspaceId) revisionBySession.delete(sessionId);
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
