/**
 * Workspace operations — assets, skills, files, doctor, registration,
 * and daemon connection helpers.
 */

import { discoverResources } from "./resource-pool.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
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
} from "@bd777/foundry-protocol";
import { nativeChatThreadsForWorkspace } from "./native-chat.js";
import {
  readDaemonConfig,
  writeDaemonConfig,
  type DaemonConfig,
} from "./config.js";
import { getJSON, postJSON } from "./transport.js";
import { providerHealthData } from "./provider-health.js";
import {
  agentProfilesForWorkspace,
  profileFingerprint,
  type UpsertAgentProfilePayload,
} from "./profiles.js";
import { deviceSystem, getDevice } from "./device.js";
import { runningWorker } from "./worker-identity.js";
import { optionValue, readOptionalText, safeID, sizeLabel } from "./utils.js";
import {
  readRegistry,
  readWorkspace,
  workspaceFilePath,
  writeIfMissing,
} from "./workspaces.js";
import { workspaceProjectionForPath } from "./issues.js";
import { status } from "./service.js";
import { ExecutionStore } from "./execution-storage.js";
import { nativeCli, outdatedNote } from "./native-cli.js";

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
  const previewConfigured =
    workspacePath !== undefined &&
    existsSync(resolve(workspacePath, ".foundry", "preview.json"));
  // Each Issue runs in its own git worktree environment, and its evidence is
  // kept beside them; accepted changes merge back into the repository.
  const root = new ExecutionStore().workspaceRoot(workspace.id);
  return [
    {
      id: "asset_local_worktree_pool",
      workspaceId: workspace.id,
      name: "Issue worktrees",
      kind: "worktree_pool",
      status: "available",
      detail: resolve(root, "environments").replace(homedir(), "~"),
    },
    {
      id: "asset_local_artifact_archive",
      workspaceId: workspace.id,
      name: "Evidence store",
      kind: "artifact_archive",
      status: "available",
      detail: resolve(root, "evidence-store").replace(homedir(), "~"),
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

  for (const path of ["AGENTS.md", "CONTEXT.md", ".foundry/skills.yaml"]) {
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
  let failed = false;
  const report = (ok: boolean, label: string) => {
    console.log(`${ok ? "OK " : "ERR"} ${label}`);
    if (!ok) failed = true;
  };

  const config = readDaemonConfig();
  console.log("Device");
  report(
    Boolean(config),
    config
      ? `paired with ${config.serverURL}`
      : "not paired; add this device from Foundry → Devices → Add device",
  );
  for (const runtime of ["claude", "codex"] as const) {
    const name = runtime === "claude" ? "Claude Code" : "Codex";
    const cli = nativeCli(runtime);
    if (!cli.installed) {
      console.log(`--  ${name} not installed. Install: ${cli.installCommand}`);
    } else if (cli.outdated) {
      console.log(`WARN ${outdatedNote(runtime, cli)}`);
    } else {
      console.log(`OK  ${name} ${cli.version ?? "(version unknown)"}`);
    }
  }

  const workspacePath = inputPath
    ? resolve(inputPath)
    : existsSync(workspaceFilePath(process.cwd()))
      ? process.cwd()
      : config?.workspacePath;
  if (!workspacePath) {
    process.exitCode = failed ? 1 : 0;
    return;
  }
  if (!existsSync(workspaceFilePath(workspacePath))) {
    report(false, `no Foundry workspace at ${workspacePath}`);
    process.exitCode = 1;
    return;
  }
  const workspace = readWorkspace(workspacePath);
  console.log(`\nWorkspace ${workspace.name}`);
  console.log(`Path: ${workspace.path}`);
  for (const file of [
    "AGENTS.md",
    "CONTEXT.md",
    ".foundry/skills.yaml",
    ".foundry/runs",
  ]) {
    report(existsSync(resolve(workspacePath, file)), file);
  }
  process.exitCode = failed ? 1 : 0;
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
  if (!workspacePath) {
    const registration = daemonDeviceRegistration();
    await postJSON(serverURL, "/api/daemon/register", registration);
    console.log(
      `Registered daemon ${registration.device.label} (no workspace yet)`,
    );
    return registration.device;
  }
  const registration = daemonRegistration(workspacePath);

  await postJSON(serverURL, "/api/daemon/register", registration);

  console.log(
    `Registered daemon ${registration.device.label} for ${registration.workspace.name}`,
  );
  return registration.device;
}

/**
 * What this worker last uploaded for each native chat, per server and
 * workspace: a sync only sends chats that changed since. In memory, so a
 * restarted worker uploads each chat once more.
 */
const uploadedChats = new Map<string, Map<string, string>>();

const summaryBatchSize = 20;

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
  const key = `${serverURL}\n${workspace.id}`;
  const uploaded = uploadedChats.get(key) ?? new Map<string, string>();
  uploadedChats.set(key, uploaded);
  // A chat carries content only (its time is its last activity, never a
  // label), so a chat nobody touched is never uploaded again.
  const fingerprint = (chat: ChatThread) =>
    createHash("sha256").update(JSON.stringify(chat)).digest("hex");
  const chats = historyIds
    ? candidates.filter((chat) => historyIds.has(chat.id))
    : candidates.filter((chat) => uploaded.get(chat.id) !== fingerprint(chat));
  // Chats this worker has not sent yet go up first as summaries, a batch per
  // request, so the whole list appears at once; the server keeps any
  // transcript it already holds for an unchanged answer.
  const unseen = chats.filter((chat) => !uploaded.has(chat.id));
  for (let offset = 0; offset < unseen.length; offset += summaryBatchSize)
    await postJSON(serverURL, "/api/daemon/chats/sync", {
      workspaceId: workspace.id,
      chats: unseen
        .slice(offset, offset + summaryBatchSize)
        .map((chat) => ({ ...chat, transcript: undefined })),
    });
  // Full detail includes typed transcripts: one chat per request so a long
  // history cannot exceed the HTTP request size limit.
  for (const chat of chats) {
    await postJSON(serverURL, "/api/daemon/chats/sync", {
      workspaceId: workspace.id,
      chats: [chat],
    });
    uploaded.set(chat.id, fingerprint(chat));
  }
  return chats.length;
}

/**
 * Native chats the server still shows as running get checked again, even when
 * they are older than the recent sessions a sync covers: a turn that was cut
 * off long ago would otherwise stay "running" there for good.
 */
export async function recheckRunningNativeChats(
  serverURL: string,
  workspacePath: string,
): Promise<number> {
  const workspace = workspaceProjectionForPath(workspacePath, getDevice());
  const { chatIds } = await getJSON<{ chatIds?: string[] }>(
    serverURL,
    `/api/daemon/chats/running?workspaceId=${encodeURIComponent(workspace.id)}`,
  );
  return chatIds?.length
    ? syncNativeChats(serverURL, workspacePath, chatIds)
    : 0;
}

/**
 * Protocol features this worker implements; the server sends only work a
 * worker declares it can run.
 */
export const daemonCapabilities = [
  "issue_sessions",
  "issue_clarification",
  "worker_update",
  "background_skill_scan",
  "tool_install",
  "tool_sources",
  "tool_registry",
  "session_usage",
  "diagnostics",
  "skill_repository_fetch",
];

export function daemonRegistration(workspacePath: string): {
  capabilities: string[];
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
    capabilities: daemonCapabilities,
    assets: assetsForWorkspace(workspaceProjection, workspacePath),
    agentProfiles,
    agents: agentsForWorkspace(
      workspaceProjection,
      device,
      workspacePath,
      agentProfiles,
    ),
    chats: [],
    device: {
      ...device,
      resources: discoverResources(),
      worker: runningWorker(),
      system: deviceSystem(),
    },
    providerHealth,
    skills: skillsForWorkspace(workspaceProjection, workspacePath),
    workspace: workspaceProjection,
    workspaceFiles: workspaceFilesForWorkspace(
      workspacePath,
      workspaceProjection.id,
    ),
  };
}

/**
 * What a worker with no workspace yet reports: the device itself, its agents'
 * runtimes and profiles. Its workspaces come later, as the person adds them.
 */
export function daemonDeviceRegistration(): Omit<
  ReturnType<typeof daemonRegistration>,
  "workspace"
> {
  const device = getDevice();
  return {
    capabilities: daemonCapabilities,
    assets: [],
    agentProfiles: agentProfilesForWorkspace(device, ""),
    agents: [],
    chats: [],
    device: {
      ...device,
      resources: discoverResources(),
      worker: runningWorker(),
      system: deviceSystem(),
    },
    providerHealth: providerHealthData(),
    skills: [],
    workspaceFiles: [],
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

/**
 * The workspace a daemon starts with, or "" for a device that has none yet:
 * it connects anyway and gets its workspaces as the person adds them. Only a
 * workspace named on the command line or recorded for this daemon counts;
 * the folder it happens to be started from never does.
 */
export function daemonWorkspacePath(args: string[]): string {
  const path = optionValue(
    args,
    "--workspace",
    readDaemonConfig()?.workspacePath,
  );
  return path ? resolve(path) : "";
}

/**
 * The workspace setup or pairing registers: only one passed with
 * `--workspace`. Installing from inside a folder that is a Foundry workspace
 * (a Foundry checkout, say) must not make it the device's workspace.
 */
export function explicitWorkspacePath(args: string[]): string {
  const path = optionValue(args, "--workspace");
  return path ? resolve(path) : "";
}

export function workspacePathFromArgs(args: string[]): string {
  return resolveConnectWorkspace(
    optionValue(args, "--workspace", readDaemonConfig()?.workspacePath),
  );
}
