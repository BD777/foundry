/**
 * Workspace registry — local workspace registration, init, and listing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  hardenPrivateFile,
  writeJSON,
  writePrivateJSONAtomic,
} from "./storage.js";
import { safeID } from "./utils.js";
import { foundryStatePath } from "./state-root.js";

// --- Types ---

export interface WorkspaceRegistryEntry {
  id: string;
  name: string;
  path: string;
  baseline: string;
  registeredAt: string;
}

export interface ForgottenWorkspaceEntry {
  id: string;
  path: string;
  forgottenAt: string;
}

export interface WorkspaceFile {
  id: string;
  name: string;
  path: string;
  baseline: string;
  createdAt: string;
  schemaVersion: 1;
}

// --- Constants ---

export const registryPath = foundryStatePath("workspaces.json");
export const forgottenWorkspacesPath = foundryStatePath(
  "forgotten-workspaces.json",
);

export function readRegistry(): WorkspaceRegistryEntry[] {
  if (!existsSync(registryPath)) {
    return [];
  }
  hardenPrivateFile(registryPath);
  const raw = readFileSync(registryPath, "utf8");
  if (raw.trim() === "") {
    return [];
  }
  return JSON.parse(raw) as WorkspaceRegistryEntry[];
}

export function writeRegistry(entries: WorkspaceRegistryEntry[]): void {
  writePrivateJSONAtomic(registryPath, entries);
}

export function readForgottenWorkspaces(): ForgottenWorkspaceEntry[] {
  if (!existsSync(forgottenWorkspacesPath)) {
    return [];
  }
  hardenPrivateFile(forgottenWorkspacesPath);
  const raw = readFileSync(forgottenWorkspacesPath, "utf8");
  if (raw.trim() === "") {
    return [];
  }
  return JSON.parse(raw) as ForgottenWorkspaceEntry[];
}

export function writeForgottenWorkspaces(
  entries: ForgottenWorkspaceEntry[],
): void {
  writePrivateJSONAtomic(forgottenWorkspacesPath, entries);
}

/**
 * Whether the person removed the workspace at this folder from Foundry. The
 * daemon then neither serves nor reports it, also when it was started with
 * it (a service installed with a folder passes it on every start).
 */
export function isForgottenWorkspaceFolder(workspacePath: string): boolean {
  const path = resolve(workspacePath);
  return readForgottenWorkspaces().some(
    (entry) => entry.path !== "" && resolve(entry.path) === path,
  );
}

export function rememberWorkspace(
  entry: Pick<WorkspaceRegistryEntry, "id" | "path">,
): void {
  const workspaceID = entry.id.trim();
  const workspacePath = resolve(entry.path);
  const entries = readForgottenWorkspaces().filter(
    (item) => item.id !== workspaceID && resolve(item.path) !== workspacePath,
  );
  writeForgottenWorkspaces(entries);
}

export function forgetWorkspaceRegistration(
  workspaceId: string,
  workspacePath: string,
): void {
  const normalizedId = workspaceId.trim();
  const normalizedPath = workspacePath ? resolve(workspacePath) : "";
  const registryEntries = readRegistry().filter((entry) => {
    const entryPath = resolve(entry.path);
    return (
      entry.id !== normalizedId &&
      (!normalizedPath || entryPath !== normalizedPath)
    );
  });
  writeRegistry(registryEntries);
  const forgotten = readForgottenWorkspaces().filter((entry) => {
    const entryPath = resolve(entry.path);
    return (
      entry.id !== normalizedId &&
      (!normalizedPath || entryPath !== normalizedPath)
    );
  });
  forgotten.push({
    id: normalizedId,
    path: normalizedPath,
    forgottenAt: new Date().toISOString(),
  });
  writeForgottenWorkspaces(forgotten);
}

export function upsertRegistry(entry: WorkspaceRegistryEntry): void {
  const entries = readRegistry().filter(
    (item) => item.path !== entry.path && item.id !== entry.id,
  );
  entries.push(entry);
  writeRegistry(entries);
  rememberWorkspace(entry);
}

/**
 * Records a workspace a daemon was started with (`--workspace`) so a restart
 * without the flag still serves it. Only an explicitly named folder is passed
 * here, never the current one; a folder the person removed stays removed, and
 * a folder that is not a Foundry workspace is left alone.
 */
export function recordExplicitWorkspace(workspacePath: string): boolean {
  if (!workspacePath) return false;
  const path = resolve(workspacePath);
  if (readRegistry().some((entry) => resolve(entry.path) === path))
    return false;
  if (!existsSync(workspaceFilePath(path))) return false;
  const workspace = readWorkspace(path);
  if (
    readForgottenWorkspaces().some(
      (entry) =>
        entry.id === workspace.id ||
        (entry.path !== "" && resolve(entry.path) === path),
    )
  )
    return false;
  writeRegistry([
    ...readRegistry().filter((entry) => entry.id !== workspace.id),
    {
      id: workspace.id,
      name: workspace.name,
      path: workspace.path,
      baseline: workspace.baseline,
      registeredAt: new Date().toISOString(),
    },
  ]);
  return true;
}

export function workspaceFilePath(workspacePath: string): string {
  return resolve(workspacePath, ".foundry", "workspace.json");
}
/**
 * The identity file travels with the checkout, so a copy or a second worktree
 * would otherwise claim the original's id and absolute path — and a stack
 * would run issues against someone else's directory. A file found somewhere
 * else describes a different workspace: it keeps its name and gets its own
 * identity for this location.
 */
export function readWorkspace(workspacePath: string): WorkspaceFile {
  const path = workspaceFilePath(workspacePath);
  if (!existsSync(path)) {
    throw new Error(`No Foundry workspace found at ${workspacePath}`);
  }
  const workspace = JSON.parse(readFileSync(path, "utf8")) as WorkspaceFile;
  const here = resolve(workspacePath);
  if (resolve(workspace.path) === here) return workspace;
  const relocated: WorkspaceFile = {
    ...workspace,
    id: `ws_${randomUUID()}`,
    name: basename(here),
    path: here,
    createdAt: new Date().toISOString(),
  };
  writePrivateJSONAtomic(path, relocated);
  return relocated;
}

/**
 * Registers a folder as a workspace. The folder is the person's: Foundry
 * writes only its own identity under `.foundry/` (kept out of Git through the
 * repository's local excludes once the folder is registered for Issues) and
 * creates its runtime folders there when it first needs them.
 */
export function initWorkspace(inputPath: string | undefined): void {
  if (!inputPath) {
    throw new Error("Usage: foundry-worker init <path>");
  }

  const workspacePath = resolve(inputPath);
  const now = new Date().toISOString();
  const existingWorkspacePath = workspaceFilePath(workspacePath);
  const existing = existsSync(existingWorkspacePath)
    ? (JSON.parse(readFileSync(existingWorkspacePath, "utf8")) as WorkspaceFile)
    : undefined;
  const workspace: WorkspaceFile = existing ?? {
    id: `ws_${randomUUID()}`,
    name: basename(workspacePath),
    path: workspacePath,
    baseline: "main",
    createdAt: now,
    schemaVersion: 1,
  };

  mkdirSync(workspacePath, { recursive: true });
  writeJSON(existingWorkspacePath, workspace);
  upsertRegistry({
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    baseline: workspace.baseline,
    registeredAt: now,
  });

  console.log(`Initialized Foundry workspace: ${workspace.name}`);
  console.log(workspace.path);
}

export function listWorkspaces(): void {
  const entries = readRegistry();
  if (entries.length === 0) {
    console.log("No local Foundry workspaces registered.");
    return;
  }
  for (const entry of entries) {
    console.log(`${entry.name}  ${entry.baseline}  ${entry.path}`);
  }
}
