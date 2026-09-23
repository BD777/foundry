/**
 * Workspace operations — assets, skills, files, doctor, registration,
 * and daemon connection helpers.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
  AgentModelOption,
  AgentProfileProjection,
  AgentProjection,
  AgentRuntimeSettings,
  AgentSession,
  AssetProjection,
  ChatThread,
  DeviceProjection,
  ProviderHealth,
  SkillPackRef,
  WorkspaceDirectoryEntry,
  WorkspaceFileEntry,
  WorkspaceFileRead,
  WorkspaceProjection,
} from "@foundry/protocol";
import { nativeChatThreadsForWorkspace } from "./native-chat.js";
import {
  readDaemonConfig,
  writeDaemonConfig,
  type DaemonConfig,
} from "./config.js";
import { postJSON } from "./transport.js";
import { providerHealthData } from "./provider-health.js";
import {
  agentProfilesForWorkspace,
  profileFingerprint,
  type UpsertAgentProfilePayload,
} from "./profiles.js";
import { getDevice } from "./device.js";
import {
  optionValue,
  readOptionalText,
  safeID,
  sizeLabel,
  yamlScalar,
} from "./utils.js";
import {
  readRegistry,
  readWorkspace,
  workspaceFilePath,
  writeIfMissing,
} from "./workspaces.js";
import { workspaceProjectionForPath } from "./issues.js";
import { status } from "./service.js";

export function defaultSkillsConfig(): string {
  return `skills:\n  issue-splitting:\n    version: 0.2.0\n    scope: workspace\n    source: .foundry/skills.yaml\n  visual-qa:\n    version: 0.9.0\n    scope: workspace\n    source: .foundry/skills.yaml\n`;
}

interface SetupWorkspacePayload {
  path: string;
}

interface ForgetWorkspacePayload {
  path: string;
  workspaceId: string;
}

interface UpsertAgentRuntimeSettingsPayload {
  settings: AgentRuntimeSettings;
}

interface ListAgentModelsPayload {
  profile: UpsertAgentProfilePayload["profile"];
}

interface RunSessionPayload {
  session: AgentSession;
}

interface SteerSessionPayload {
  message?: string;
  sessionId?: string;
}

interface CancelSessionPayload {
  sessionId?: string;
}

interface AgentSessionCompletionMarker {
  completedAt: string;
  nativeSessionId?: string;
  response: string;
  sessionId: string;
  status: "completed";
}

export function sessionSchedulingKey(session: AgentSession): string {
  const conversationID =
    session.threadId?.trim() || session.nativeSessionId?.trim();
  if (conversationID) {
    return [
      "session",
      session.workspaceId,
      session.provider,
      conversationID,
    ].join(":");
  }
  return `session:${session.id}`;
}

export function assetsForWorkspace(
  workspace: WorkspaceProjection,
  workspacePath?: string,
): AssetProjection[] {
  const assetsConfig = workspacePath
    ? readOptionalText(resolve(workspacePath, ".foundry", "assets.yaml"))
    : undefined;
  const previewConfigured =
    workspacePath !== undefined &&
    existsSync(resolve(workspacePath, ".foundry", "preview.json"));
  const archivePath = yamlScalar(assetsConfig, "path") ?? "accepted";
  const worktreeStrategy = yamlScalar(assetsConfig, "strategy") ?? "per_issue";
  return [
    {
      id: "asset_local_worktree_pool",
      workspaceId: workspace.id,
      name: "Local worktree pool",
      kind: "worktree_pool",
      status: assetsConfig ? "available" : "missing",
      detail: assetsConfig
        ? `${worktreeStrategy} · .foundry/assets.yaml`
        : "missing .foundry/assets.yaml",
    },
    {
      id: "asset_local_artifact_archive",
      workspaceId: workspace.id,
      name: "Local artifact archive",
      kind: "artifact_archive",
      status: assetsConfig ? "available" : "missing",
      detail: assetsConfig
        ? `${archivePath} · .foundry/assets.yaml`
        : "missing .foundry/assets.yaml",
    },
    {
      id: "asset_local_preview_ports",
      workspaceId: workspace.id,
      name: "Local preview ports",
      kind: "preview_ports",
      status: previewConfigured ? "available" : "missing",
      detail: previewConfigured
        ? ".foundry/preview.json"
        : "copy preview.example.json to preview.json",
    },
  ];
}

export function skillsForWorkspace(
  workspace: WorkspaceProjection,
  workspacePath: string,
): SkillPackRef[] {
  const source = ".foundry/skills.yaml";
  const text = readOptionalText(resolve(workspacePath, source));
  if (!text) {
    return [];
  }

  const skills: SkillPackRef[] = [];
  let current: Partial<SkillPackRef> | undefined;
  const finishCurrent = (): void => {
    if (!current?.name) {
      return;
    }
    skills.push({
      id: current.id ?? current.name,
      name: current.name,
      scope: current.scope ?? "workspace",
      source: current.source ?? source,
      version: current.version ?? "0.0.0",
      workspaceId: workspace.id,
    });
  };

  for (const line of text.split(/\r?\n/)) {
    const skillMatch = /^  ([a-zA-Z0-9_.-]+):\s*$/.exec(line);
    if (skillMatch) {
      finishCurrent();
      current = {
        id: skillMatch[1],
        name: skillMatch[1],
      };
      continue;
    }
    const fieldMatch = /^    ([a-zA-Z0-9_-]+):\s*(.+?)\s*$/.exec(line);
    if (fieldMatch && current) {
      const key = fieldMatch[1] ?? "";
      const value = (fieldMatch[2] ?? "").replace(/^["']|["']$/g, "");
      if (key === "version") {
        current.version = value;
      } else if (key === "scope") {
        current.scope = value as SkillPackRef["scope"];
      } else if (key === "source") {
        current.source = value;
      }
    }
  }
  finishCurrent();

  return skills;
}

export function ensureRuntimeWorkspaceFiles(workspacePath: string): void {
  const foundryPath = resolve(workspacePath, ".foundry");
  if (!existsSync(foundryPath)) {
    return;
  }
  writeIfMissing(
    resolve(foundryPath, "skills.yaml"),
    defaultSkillsConfig(),
    0o700,
  );
}

export function agentsForWorkspace(
  workspace: WorkspaceProjection,
  device: DeviceProjection,
  workspacePath: string,
  profiles: AgentProfileProjection[] = agentProfilesForWorkspace(
    device,
    workspacePath,
  ),
): AgentProjection[] {
  return profiles.map((profile) => ({
    id: `agent_${safeID(device.id)}_${safeID(workspace.id)}_${profile.id}`,
    workspaceId: workspace.id,
    deviceId: device.id,
    deviceLabel: device.label,
    provider: profile.runtime,
    profileId: profile.id,
    profileFingerprint: profile.fingerprint,
    profileLabel: profile.label,
    connectionType: profile.connectionType,
    status: profile.status,
    authMode: profile.authMode,
    secretStored: profile.secretStored,
    configScope: profile.configScope,
    configLabel: profile.configLabel,
    lastSeenLabel: device.lastSeenLabel,
    statusDetail: profile.statusDetail,
  }));
}

export function workspaceFileID(workspaceID: string, path: string): string {
  return `file_${safeID(workspaceID)}_${safeID(path || "root")}`;
}

export function workspaceFilesForWorkspace(
  workspacePath: string,
  workspaceID: string,
): WorkspaceFileEntry[] {
  const ignored = new Set([".git", "node_modules", "dist", "build"]);
  const entries: WorkspaceFileEntry[] = [];
  const root = resolve(workspacePath);
  if (!existsSync(root)) {
    return entries;
  }

  for (const entry of readdirSync(root, { withFileTypes: true }).slice(
    0,
    120,
  )) {
    if (ignored.has(entry.name)) {
      continue;
    }
    const absolutePath = resolve(root, entry.name);
    let stat;
    try {
      stat = statSync(absolutePath);
    } catch {
      continue;
    }
    const kind = entry.isDirectory() ? "directory" : "file";
    entries.push({
      id: workspaceFileID(workspaceID, entry.name),
      workspaceId: workspaceID,
      path: entry.name,
      name: entry.name,
      kind,
      sizeLabel: kind === "directory" ? "directory" : sizeLabel(stat.size),
      updatedLabel: "local",
    });
  }

  for (const path of [
    "AGENTS.md",
    "CONTEXT.md",
    ".foundry/assets.yaml",
    ".foundry/providers.yaml",
    ".foundry/skills.yaml",
  ]) {
    if (entries.some((entry) => entry.path === path)) {
      continue;
    }
    const absolutePath = resolve(root, path);
    if (!existsSync(absolutePath)) {
      continue;
    }
    const stat = statSync(absolutePath);
    entries.push({
      id: workspaceFileID(workspaceID, path),
      workspaceId: workspaceID,
      path,
      name: basename(path),
      kind: "file",
      sizeLabel: sizeLabel(stat.size),
      updatedLabel: "local",
    });
  }

  return entries.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "file" ? -1 : 1;
    }
    return left.path.localeCompare(right.path);
  });
}

export function doctor(inputPath: string | undefined): void {
  const workspacePath = resolve(inputPath ?? process.cwd());
  const workspace = readWorkspace(workspacePath);
  const checks = [
    ["AGENTS.md", existsSync(resolve(workspacePath, "AGENTS.md"))],
    ["CONTEXT.md", existsSync(resolve(workspacePath, "CONTEXT.md"))],
    [
      ".foundry/assets.yaml",
      existsSync(resolve(workspacePath, ".foundry", "assets.yaml")),
    ],
    [
      ".foundry/providers.yaml",
      existsSync(resolve(workspacePath, ".foundry", "providers.yaml")),
    ],
    [
      ".foundry/skills.yaml",
      existsSync(resolve(workspacePath, ".foundry", "skills.yaml")),
    ],
    [".foundry/runs", existsSync(resolve(workspacePath, ".foundry", "runs"))],
  ] as const;

  console.log(`Workspace: ${workspace.name}`);
  console.log(`Path: ${workspace.path}`);
  for (const [label, ok] of checks) {
    console.log(`${ok ? "OK " : "ERR"} ${label}`);
  }
}

export function providerHealth(args: string[]): void {
  const workspaceInput = optionValue(args, "--workspace");
  const workspacePath = workspaceInput
    ? resolveConnectWorkspace(workspaceInput)
    : undefined;
  const providers = providerHealthData();

  for (const provider of providers) {
    const statusLabel =
      provider.status === "healthy" ? "configured" : provider.status;
    console.log(
      `${provider.provider}: ${statusLabel} (${provider.authMode}, secret ${provider.secretStored})${
        provider.statusDetail ? ` - ${provider.statusDetail}` : ""
      }`,
    );
  }
}

export function resolveConnectWorkspace(inputPath: string | undefined): string {
  if (inputPath) {
    return resolve(inputPath);
  }
  const cwd = process.cwd();
  if (existsSync(workspaceFilePath(cwd))) {
    return cwd;
  }
  const first = readRegistry()[0];
  if (first) {
    return first.path;
  }
  throw new Error(
    "No workspace passed and no local Foundry workspace is registered.",
  );
}

export async function registerDaemon(
  serverURL: string,
  workspacePath: string,
): Promise<DeviceProjection> {
  const registration = daemonRegistration(workspacePath);

  await postJSON(serverURL, "/api/daemon/register", registration);

  console.log(
    `Registered daemon ${registration.device.label} for ${registration.workspace.name}`,
  );
  return registration.device;
}

export async function syncNativeChats(
  serverURL: string,
  workspacePath: string,
  historicalChatIds?: readonly string[],
): Promise<number> {
  const device = getDevice();
  const workspace = workspaceProjectionForPath(workspacePath, device);
  const profiles = agentProfilesForWorkspace(
    device,
    workspacePath,
    providerHealthData(),
  );
  // Backfills must target existing records, not discover extra list entries.
  const historyIds = historicalChatIds ? new Set(historicalChatIds) : undefined;
  const candidates = await nativeChatThreadsForWorkspace(
    workspace,
    profiles,
    historyIds ? Number.POSITIVE_INFINITY : 60,
  );
  const chats = historyIds
    ? candidates.filter((chat) => historyIds.has(chat.id))
    : candidates;
  // Detail now includes typed transcripts. Sync each chat independently so a
  // workspace's combined history cannot exceed the HTTP request size limit.
  for (const chat of chats) {
    await postJSON(serverURL, "/api/daemon/chats/sync", {
      workspaceId: workspace.id,
      chats: [chat],
    });
  }
  return chats.length;
}

export function daemonRegistration(workspacePath: string): {
  assets: AssetProjection[];
  agentProfiles: AgentProfileProjection[];
  agents: AgentProjection[];
  chats: ChatThread[];
  device: DeviceProjection;
  providerHealth: ProviderHealth[];
  skills: SkillPackRef[];
  workspace: WorkspaceProjection;
  workspaceFiles: WorkspaceFileEntry[];
} {
  ensureRuntimeWorkspaceFiles(workspacePath);
  const device = getDevice();
  const workspaceProjection = workspaceProjectionForPath(workspacePath, device);
  const providerHealth = providerHealthData();
  const agentProfiles = agentProfilesForWorkspace(device, workspacePath);

  return {
    assets: assetsForWorkspace(workspaceProjection, workspacePath),
    agentProfiles,
    agents: agentsForWorkspace(
      workspaceProjection,
      device,
      workspacePath,
      agentProfiles,
    ),
    chats: [],
    device,
    providerHealth,
    skills: skillsForWorkspace(workspaceProjection, workspacePath),
    workspace: workspaceProjection,
    workspaceFiles: workspaceFilesForWorkspace(
      workspacePath,
      workspaceProjection.id,
    ),
  };
}

export function serverURLFromArgs(args: string[]): string {
  return optionValue(
    args,
    "--server",
    process.env.FOUNDRY_SERVER_URL ??
      readDaemonConfig()?.serverURL ??
      "http://127.0.0.1:31982",
  )!;
}

export function workspacePathFromArgs(args: string[]): string {
  return resolveConnectWorkspace(
    optionValue(args, "--workspace", readDaemonConfig()?.workspacePath),
  );
}
