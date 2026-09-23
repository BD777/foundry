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
  writePublicTextIfMissing,
} from "./storage.js";
import { safeID } from "./utils.js";
import { foundryStatePath } from "./state-root.js";

const VERSION = "0.0.0";

function defaultSkillsConfig(): string {
  return `skills:\n  issue-splitting:\n    version: 0.2.0\n    scope: workspace\n    source: .foundry/skills.yaml\n  visual-qa:\n    version: 0.9.0\n    scope: workspace\n    source: .foundry/skills.yaml\n`;
}

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

export function writeIfMissing(
  path: string,
  contents: string,
  directoryMode = 0o755,
): void {
  writePublicTextIfMissing(path, contents, directoryMode);
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

export function initWorkspace(inputPath: string | undefined): void {
  if (!inputPath) {
    throw new Error("Usage: foundry-worker init <path>");
  }

  const workspacePath = resolve(inputPath);
  const foundryPath = resolve(workspacePath, ".foundry");
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
  mkdirSync(resolve(workspacePath, "artifacts", "issues"), { recursive: true });
  mkdirSync(resolve(workspacePath, "accepted"), { recursive: true });
  mkdirSync(resolve(foundryPath, "issues"), { mode: 0o700, recursive: true });
  mkdirSync(resolve(foundryPath, "integrations"), {
    mode: 0o700,
    recursive: true,
  });
  mkdirSync(resolve(foundryPath, "runs"), { mode: 0o700, recursive: true });
  mkdirSync(resolve(foundryPath, "reviews"), { mode: 0o700, recursive: true });
  mkdirSync(resolve(foundryPath, "worktrees"), {
    mode: 0o700,
    recursive: true,
  });

  writeIfMissing(
    resolve(workspacePath, "AGENTS.md"),
    `# ${workspace.name}\n\nFoundry workers should treat this workspace context as authoritative.\n\n- Workspace evolves.\n- Skills accumulate.\n- Workers do not remember.\n`,
  );
  writeIfMissing(
    resolve(workspacePath, "CONTEXT.md"),
    `# Context\n\n${workspace.name} is a Foundry workspace.\n\nCurrent baseline: \`${workspace.baseline}\`\n`,
  );
  writeJSON(existingWorkspacePath, workspace);
  writeIfMissing(
    resolve(foundryPath, "assets.yaml"),
    `assets:\n  worktree_pool:\n    kind: git_worktree\n    strategy: per_issue\n  artifact_archive:\n    kind: artifact_archive\n    path: accepted\n`,
    0o700,
  );
  writeIfMissing(
    resolve(foundryPath, "skills.yaml"),
    defaultSkillsConfig(),
    0o700,
  );
  writeIfMissing(
    resolve(foundryPath, "providers.yaml"),
    `providers:\n  claude:\n    auth: local\n    secret: local-only\n  codex:\n    auth: local\n    secret: local-only\n`,
    0o700,
  );
  writeIfMissing(
    resolve(foundryPath, "agent-profiles.local.example.json"),
    `${JSON.stringify(
      {
        profiles: [
          {
            id: "codex-third-party",
            label: "Codex Third-party",
            runtime: "codex",
            connectionType: "openai_compatible",
            baseUrl: "https://provider.example/v1",
            model: "model-name",
            apiKey: "local-only",
          },
          {
            id: "claude-provider-a",
            label: "Claude Provider A",
            runtime: "claude",
            connectionType: "anthropic_compatible",
            baseUrl: "https://provider.example",
            model: "model-name",
            apiKey: "local-only",
          },
        ],
      },
      null,
      2,
    )}\n`,
    0o700,
  );
  writeIfMissing(
    resolve(foundryPath, "preview.example.json"),
    `${JSON.stringify(
      {
        command: "pnpm dev --host 127.0.0.1 --port $FOUNDRY_PREVIEW_PORT",
        portStart: 4300,
        portEnd: 4399,
        readyPath: "/",
        readyTimeoutMs: 15000,
      },
      null,
      2,
    )}\n`,
    0o700,
  );
  writeJSON(resolve(foundryPath, "daemon.json"), {
    version: VERSION,
    updatedAt: now,
  });

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
