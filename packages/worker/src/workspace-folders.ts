/**
 * Workspace folders that move: which of the device's workspaces still have
 * their folder, serving a workspace (same identity) from the folder it was
 * moved or renamed to, and finding where it went.
 */

import {
  constants,
  copyFileSync,
  cpSync,
  mkdirSync,
  opendirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type {
  FindMovedWorkspacePayload,
  RelinkWorkspacePayload,
  WorkspaceNativeSessionsMoved,
  WorkspaceRelinkSuggestion,
} from "@bd777/foundry-protocol";
import {
  readForgottenWorkspaces,
  readRegistry,
  upsertRegistry,
  workspaceFilePath,
  type WorkspaceFile,
} from "./workspaces.js";
import { writeJSON } from "./storage.js";
import {
  existingWorkspaceFolder,
  workspaceFolderPresent,
} from "./workspace-registration.js";
import {
  canonical,
  ExecutionStore,
  identifier,
  within,
} from "./execution-storage.js";
import { findSessionLog } from "./native-usage.js";
import { claudeHomeCandidates, codexHomeCandidates } from "./native-chat.js";
import { configuredAgentProfiles } from "./profiles.js";
import { moveSkillReceipt } from "./skill-isolation.js";
import { errorMessage } from "./utils.js";

export interface RegistryWorkspaceFolder {
  id: string;
  path: string;
  present: boolean;
}

/**
 * The workspaces this device keeps (its registry, less the ones the person
 * removed) and whether each one's folder is there.
 */
export function registryWorkspaceFolders(): RegistryWorkspaceFolder[] {
  const forgotten = readForgottenWorkspaces();
  return readRegistry()
    .filter(
      (entry) =>
        !forgotten.some(
          (item) =>
            item.id === entry.id ||
            (item.path !== "" && resolve(item.path) === resolve(entry.path)),
        ),
    )
    .map((entry) => ({
      id: entry.id,
      path: resolve(entry.path),
      present: workspaceFolderPresent(entry.path),
    }));
}

/** The workspace file in a folder, when it is readable at all. */
export function readWorkspaceFile(
  folder: string,
): Partial<WorkspaceFile> | undefined {
  if (!folder) return undefined;
  try {
    const parsed = JSON.parse(
      readFileSync(workspaceFilePath(folder), "utf8"),
    ) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Partial<WorkspaceFile>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a registry entry's folder holds that workspace itself (its own
 * id and path), not another folder put in its place.
 */
export function holdsRegisteredWorkspace(
  entry: RegistryWorkspaceFolder,
): boolean {
  const file = readWorkspaceFile(entry.path);
  return (
    file?.id === entry.id &&
    typeof file.path === "string" &&
    resolve(file.path) === entry.path
  );
}

// --- Native sessions -------------------------------------------------------

/**
 * The directory Claude Code keeps a working directory's sessions in, under
 * <config>/projects/: the real path with every character but [A-Za-z0-9]
 * replaced by "-", long names cut at 200 characters plus a hash of the path
 * (as the Claude Agent SDK's session lookup does).
 */
export function claudeProjectDirectoryName(folder: string): string {
  let path: string;
  try {
    path = realpathSync(folder);
  } catch {
    path = canonical(folder);
  }
  if (process.platform === "darwin") path = path.normalize("NFC");
  const name = path.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= 200) return name;
  let hash = 0;
  for (let index = 0; index < path.length; index += 1)
    hash = ((hash << 5) - hash + path.charCodeAt(index)) | 0;
  return `${name.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

export interface NativeSessionHomes {
  claude: string[];
  codex: string[];
}

/**
 * Where this device's native sessions are kept: the worker's own Claude and
 * Codex homes, and any a device profile points its runtime at.
 */
export function nativeSessionHomes(): NativeSessionHomes {
  const claude = claudeHomeCandidates();
  const codex = codexHomeCandidates();
  try {
    for (const profile of configuredAgentProfiles("")) {
      const claudeHome = profile.env?.CLAUDE_CONFIG_DIR?.trim();
      const codexHome = profile.env?.CODEX_HOME?.trim();
      if (claudeHome && workspaceFolderPresent(claudeHome))
        claude.push(resolve(claudeHome));
      if (codexHome && workspaceFolderPresent(codexHome))
        codex.push(resolve(codexHome));
    }
  } catch {
    /* Profiles that cannot be read add no homes. */
  }
  return { claude: [...new Set(claude)], codex: [...new Set(codex)] };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Copies a native session's transcript (<id>.jsonl) and its directory
 * (<id>/: subagents, tool results) into another project directory. Never
 * moves, never overwrites.
 */
function copyClaudeSession(from: string, to: string, id: string): boolean {
  const transcript = join(to, `${id}.jsonl`);
  if (isFile(transcript)) return false;
  mkdirSync(to, { recursive: true, mode: 0o700 });
  copyFileSync(join(from, `${id}.jsonl`), transcript, constants.COPYFILE_EXCL);
  if (
    workspaceFolderPresent(join(from, id)) &&
    !workspaceFolderPresent(join(to, id))
  )
    cpSync(join(from, id), join(to, id), {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  return true;
}

/**
 * Makes a moved workspace's native sessions resumable in its new folder.
 * Claude Code looks a session up in the project directory of the working
 * directory, so each one is copied into the new folder's (in the same home);
 * Codex resumes a thread by id wherever it runs, so there is nothing to do.
 * The old folder's other Claude sessions (native chats Foundry did not
 * start) and its Claude project memory are copied along, uncounted.
 */
export async function moveNativeSessions(input: {
  previousPath: string;
  path: string;
  nativeSessions: RelinkWorkspacePayload["nativeSessions"];
  homes?: NativeSessionHomes;
}): Promise<WorkspaceNativeSessionsMoved> {
  const homes = input.homes ?? nativeSessionHomes();
  const moved: WorkspaceNativeSessionsMoved = {
    copied: 0,
    alreadyThere: 0,
    notFound: 0,
  };
  const newName = claudeProjectDirectoryName(input.path);
  const seen = new Set<string>();
  for (const { provider, id: rawId } of input.nativeSessions ?? []) {
    const id = rawId?.trim() ?? "";
    if (provider !== "claude" && provider !== "codex") continue;
    if (seen.has(`${provider}:${id}`)) continue;
    seen.add(`${provider}:${id}`);
    if (!/^[\w-]{8,}$/.test(id)) {
      moved.notFound += 1;
      continue;
    }
    if (provider === "codex") {
      if (await findSessionLog("codex", id, homes.codex))
        moved.alreadyThere += 1;
      else moved.notFound += 1;
      continue;
    }
    if (
      homes.claude.some((home) =>
        isFile(join(home, "projects", newName, `${id}.jsonl`)),
      )
    ) {
      moved.alreadyThere += 1;
      continue;
    }
    let copied = false;
    for (const home of homes.claude) {
      const found = await findSessionLog("claude", id, [home]);
      if (!found) continue;
      try {
        copied = copyClaudeSession(
          dirname(found),
          join(home, "projects", newName),
          id,
        );
      } catch (error) {
        console.error(
          `Copying Claude session ${id} to ${input.path} failed: ${errorMessage(error)}`,
        );
        continue;
      }
      if (copied) break;
    }
    if (copied) moved.copied += 1;
    else moved.notFound += 1;
  }
  if (input.previousPath) copyOtherClaudeSessions(homes.claude, input, newName);
  // A session's receipt names the folder it ran in; it is this one now.
  for (const { id } of input.nativeSessions ?? [])
    if (id?.trim()) {
      for (const from of new Set([
        input.previousPath,
        resolve(input.previousPath),
      ]))
        if (from) moveSkillReceipt(id.trim(), from, input.path);
    }
  return moved;
}

function copyOtherClaudeSessions(
  claudeHomes: string[],
  input: { previousPath: string; path: string },
  newName: string,
): void {
  const oldNames = new Set([
    claudeProjectDirectoryName(input.previousPath),
    resolve(input.previousPath).replace(/[^a-zA-Z0-9]/g, "-"),
  ]);
  oldNames.delete(newName);
  for (const home of claudeHomes)
    for (const oldName of oldNames) {
      const from = join(home, "projects", oldName);
      const to = join(home, "projects", newName);
      let names: string[];
      try {
        names = readdirSync(from);
      } catch {
        continue;
      }
      for (const name of names) {
        try {
          if (name.endsWith(".jsonl") && isFile(join(from, name)))
            copyClaudeSession(from, to, name.slice(0, -".jsonl".length));
          else if (
            name === "memory" &&
            workspaceFolderPresent(join(from, name)) &&
            !workspaceFolderPresent(join(to, name))
          )
            cpSync(join(from, name), join(to, name), {
              recursive: true,
              force: false,
              errorOnExist: false,
            });
        } catch (error) {
          console.error(
            `Copying ${join(from, name)} to ${to} failed: ${errorMessage(error)}`,
          );
        }
      }
    }
}

// --- Relink ----------------------------------------------------------------

/**
 * The workspace's Issue registration names its folder and repositories by
 * path; it follows the folder now, before the rescan that refreshes it.
 */
async function relocateExecutionRegistration(
  workspaceId: string,
  path: string,
  store: ExecutionStore,
): Promise<void> {
  const to = canonical(path);
  const before = store.registration(workspaceId);
  if (!before || before.sourcePath === to) return;
  await store.lock(workspaceId, "registration", async () => {
    const current = store.registration(workspaceId);
    if (!current || current.sourcePath === to) return;
    const from = current.sourcePath;
    const follow = (value: string): string =>
      value && within(from, value) ? resolve(to, relative(from, value)) : value;
    store.saveRegistration({
      ...current,
      sourcePath: to,
      repositories: current.repositories.map((repository) => ({
        ...repository,
        sourcePath: follow(repository.sourcePath),
        gitDirectory: follow(repository.gitDirectory),
        commonDirectory: follow(repository.commonDirectory),
      })),
    });
  });
}

export interface RelinkedWorkspace {
  workspace: WorkspaceFile;
  nativeSessions: WorkspaceNativeSessionsMoved;
}

/**
 * Serves a workspace from another folder, keeping its identity: its
 * workspace file there names the same id (replacing one with another id, a
 * copy's), the registry points at the folder, and its Issue registration and
 * native sessions follow it.
 */
export async function relinkWorkspaceFolder(
  payload: RelinkWorkspacePayload,
  options: { store?: ExecutionStore; homes?: NativeSessionHomes } = {},
): Promise<RelinkedWorkspace> {
  const workspaceId = payload.workspaceId?.trim() ?? "";
  if (!workspaceId) throw new Error("relink_workspace requires workspaceId");
  identifier(workspaceId);
  const path = existingWorkspaceFolder(payload.path ?? "");
  const previousPath = payload.previousPath?.trim()
    ? resolve(payload.previousPath)
    : "";
  const registered = readRegistry().find((entry) => entry.id === workspaceId);
  // The moved folder usually carries its own file, which still names the
  // old path: readWorkspace would take it for a copy and give it a new id,
  // so this writes the file before anything reads it that way.
  const earlier = [
    readWorkspaceFile(previousPath),
    readWorkspaceFile(path),
  ].find((file) => file?.id === workspaceId);
  const now = new Date().toISOString();
  const workspace: WorkspaceFile = {
    id: workspaceId,
    name: basename(path),
    path,
    baseline: earlier?.baseline || registered?.baseline || "main",
    createdAt: earlier?.createdAt || now,
    schemaVersion: 1,
  };
  writeJSON(workspaceFilePath(path), workspace);
  upsertRegistry({
    id: workspaceId,
    name: workspace.name,
    path,
    baseline: workspace.baseline,
    registeredAt: registered?.registeredAt ?? now,
  });
  await relocateExecutionRegistration(
    workspaceId,
    path,
    options.store ?? new ExecutionStore(),
  );
  const nativeSessions = await moveNativeSessions({
    previousPath,
    path,
    nativeSessions: payload.nativeSessions ?? [],
    homes: options.homes,
  });
  return { workspace, nativeSessions };
}

// --- Finding a moved folder -------------------------------------------------

const maxEntries = 500;
const maxSuggestions = 5;

/**
 * Folders near a missing workspace's last path that hold its identity: its
 * nearest existing ancestor's subdirectories (and, when a parent folder was
 * renamed, the same place under each of them). A folder registered as
 * another workspace is never offered.
 *
 * Git remotes are not compared: the worker records no origin URL for a
 * workspace's repositories, and the folder that had it is gone.
 */
export function findMovedWorkspaceFolders(
  payload: FindMovedWorkspacePayload,
): WorkspaceRelinkSuggestion[] {
  const workspaceId = payload.workspaceId?.trim() ?? "";
  if (!workspaceId || !payload.previousPath?.trim()) return [];
  const previousPath = resolve(payload.previousPath);
  let ancestor = dirname(previousPath);
  while (!workspaceFolderPresent(ancestor)) {
    const up = dirname(ancestor);
    if (up === ancestor) return [];
    ancestor = up;
  }
  // The rest of the old path below the ancestor's child that was renamed.
  const below = relative(ancestor, previousPath).split(sep).slice(1).join(sep);
  const otherWorkspaces = new Set(
    readRegistry()
      .filter((entry) => entry.id !== workspaceId)
      .map((entry) => resolve(entry.path)),
  );
  const found: { path: string; byId: boolean }[] = [];
  let directory;
  try {
    directory = opendirSync(ancestor);
  } catch {
    return [];
  }
  try {
    for (let count = 0; count < maxEntries; count += 1) {
      const entry = directory.readSync();
      if (!entry) break;
      if (
        !entry.isDirectory() ||
        entry.name.startsWith(".") ||
        entry.name === "node_modules"
      )
        continue;
      const sibling = join(ancestor, entry.name);
      for (const candidate of below
        ? [sibling, join(sibling, below)]
        : [sibling]) {
        if (otherWorkspaces.has(candidate) || candidate === previousPath)
          continue;
        const file = readWorkspaceFile(candidate);
        if (!file) continue;
        const byId = file.id === workspaceId;
        const byPath =
          typeof file.path === "string" && resolve(file.path) === previousPath;
        if (byId || byPath) found.push({ path: candidate, byId });
      }
    }
  } finally {
    directory.closeSync();
  }
  return found
    .sort(
      (left, right) =>
        Number(right.byId) - Number(left.byId) ||
        left.path.localeCompare(right.path),
    )
    .slice(0, maxSuggestions)
    .map(({ path }) => ({ path, reason: "same_workspace" }));
}
