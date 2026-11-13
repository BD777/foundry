// The person's assistant reads its instructions the way Claude Code and
// Codex read any project's: from its folder's AGENTS.md, with skill folders in
// each runtime's native discovery path. Foundry sends canonical files with
// each run (run_session's personalAgentFiles, docs/personal-agent.md §12);
// the worker writes them and creates the runtime links before the runtime
// starts. AGENTS.md holds the person's rules and the facts they confirmed;
// live state comes from tools, never with each turn's input.

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AgentSession, SetupWorkspaceFile } from "@bd777/foundry-protocol";
import { writeFileAtomic } from "../platform/storage.js";
import { within } from "../platform/paths.js";

/** The only files Foundry writes into the assistant's folder for a run. */
const assistantFilePath =
  /^(AGENTS\.md|\.foundry\/[A-Za-z0-9._-]+\.md|\.foundry\/assistant-skills\/[A-Za-z0-9][A-Za-z0-9_-]*\/SKILL\.md)$/;
const assistantSkillPath =
  /^\.foundry\/assistant-skills\/([A-Za-z0-9][A-Za-z0-9_-]*)\/SKILL\.md$/;
const assistantSkillsRoot = [".foundry", "assistant-skills"];
const runtimeSkillRoots = [
  [".claude", "skills"],
  [".agents", "skills"],
];

interface AssistantSkillFile {
  name: string;
  path: string;
  content: string;
}

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
 * Any other session's files are ignored, and so are a read-only workspace
 * session's: nothing it runs for may write its workspace.
 */
export function writePersonalAgentFiles(
  session: AgentSession,
  workspacePath: string,
  files: SetupWorkspaceFile[] | undefined,
): void {
  if (
    session.role !== "personal_agent" ||
    session.workspaceAccess === "read" ||
    !session.id ||
    !files?.length
  )
    return;
  for (const file of files) {
    if (!assistantFilePath.test(file.path))
      throw new Error(
        `Foundry does not write ${file.path} into the assistant's folder`,
      );
  }
  const skills = files.flatMap((file): AssistantSkillFile[] => {
    const name = assistantSkillPath.exec(file.path)?.[1];
    return name ? [{ name, path: file.path, content: file.content }] : [];
  });
  if (new Set(skills.map((skill) => skill.name)).size !== skills.length)
    throw new Error("Foundry received duplicate assistant skill names");
  if (skills.length > 0) syncAssistantSkills(workspacePath, skills);

  const revision = createHash("sha256");
  for (const file of files) {
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

/**
 * Replace every Foundry-managed assistant skill. One canonical directory
 * holds the content; both runtimes receive directory links, so an edit cannot
 * leave one runtime on an older version than the other.
 */
function syncAssistantSkills(
  workspacePath: string,
  skills: AssistantSkillFile[],
): void {
  const canonicalRoot = join(workspacePath, ...assistantSkillsRoot);
  clearAssistantSkills(workspacePath, canonicalRoot);
  for (const skill of skills) {
    const target = join(workspacePath, skill.path);
    writeFileAtomic(target, skill.content, {
      mode: 0o644,
      directoryMode: 0o755,
      hardenParent: false,
    });
  }
  for (const root of runtimeSkillRoots) {
    const skillsRoot = join(workspacePath, ...root);
    mkdirSync(skillsRoot, { recursive: true, mode: 0o755 });
    for (const skill of skills) {
      const link = join(skillsRoot, skill.name);
      rmSync(link, { recursive: true, force: true });
      const target = join(canonicalRoot, skill.name);
      symlinkSync(
        join("..", "..", ...assistantSkillsRoot, skill.name),
        link,
        "dir",
      );
      if (!existsSync(target))
        throw new Error(`assistant skill target is missing: ${target}`);
    }
  }
}

function clearAssistantSkills(
  workspacePath: string,
  canonicalRoot: string,
): void {
  for (const root of runtimeSkillRoots) {
    const skillsRoot = join(workspacePath, ...root);
    if (!existsSync(skillsRoot) || !lstatSync(skillsRoot).isDirectory())
      continue;
    for (const entry of readdirSync(skillsRoot)) {
      const path = join(skillsRoot, entry);
      if (!lstatSync(path).isSymbolicLink()) continue;
      const target = resolve(dirname(path), readlinkSync(path));
      if (within(canonicalRoot, target)) unlinkSync(path);
    }
  }
  rmSync(canonicalRoot, { recursive: true, force: true });
}
