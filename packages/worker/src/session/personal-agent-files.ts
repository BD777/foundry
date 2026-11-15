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
    if (
      file.managedBlock &&
      (file.path !== "AGENTS.md" ||
        !file.content.startsWith(managedBlockStart) ||
        !file.content.trimEnd().endsWith(managedBlockEnd))
    )
      throw new Error("Foundry sent a malformed managed block for AGENTS.md");
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
    const target = join(workspacePath, file.path);
    const current = readIfPresent(target);
    const content = file.managedBlock
      ? withManagedBlock(current, file.content, file.seed ?? "")
      : file.content;
    // The whole file as written: an edit of the person's part of AGENTS.md
    // starts a new runtime too, which reads it.
    revision.update(`${file.path}\0${content}\0`);
    if (current === content) continue;
    writeFileAtomic(target, content, {
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

/** Where Foundry's managed block of AGENTS.md starts and ends (DEV-223). */
export const managedBlockStart = "<!-- foundry:managed:start";
export const managedBlockEnd = "<!-- foundry:managed:end -->";

/**
 * Headings only an AGENTS.md Foundry wrote whole has outside a managed
 * block (before DEV-223): such a file is Foundry's, not the person's.
 */
const wholeFileHeadings = [
  "\n# The person's rules\n",
  "\n# What the person confirmed (newest first)\n",
];

/**
 * AGENTS.md with Foundry's managed `block` in place of the one it holds and
 * everything else kept. A missing file, or one Foundry wrote whole, becomes
 * the block and `seed`; a file without a block (the person removed it) gets
 * it on top.
 */
export function withManagedBlock(
  current: string | undefined,
  block: string,
  seed: string,
): string {
  const fresh = () =>
    `${block.trimEnd()}\n\n${seed.trimStart()}`.trimEnd() + "\n";
  if (current === undefined) return fresh();
  const start = current.indexOf(managedBlockStart);
  const end = start < 0 ? -1 : current.indexOf(managedBlockEnd, start);
  if (start >= 0 && end >= 0)
    return (
      current.slice(0, start) +
      block.trimEnd() +
      current.slice(end + managedBlockEnd.length)
    );
  if (wholeFileHeadings.every((heading) => current.includes(heading)))
    return fresh();
  return `${block.trimEnd()}\n\n${current.trimStart()}`;
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
