/**
 * Workspace operations — assets, skills, files, doctor, registration,
 * and daemon connection helpers.
 */

import { discoverResources } from "./resources/index.js";
import {
  executionHostClient,
  type ExecutionHostClient,
} from "./execution-host/client.js";
import {
  chatFingerprint,
  chatUploads,
  reconcileWithServer,
  rememberUpload,
} from "./chat-uploads.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  deviceConnectorsCapability,
  deviceSharingCapability,
  resourceComputeCapability,
  resourceOperationsCapability,
  resourcesCapability,
  workspaceCreateCapability,
  workspaceFoldersCapability,
} from "@bd777/foundry-protocol";
import type {
  AgentModelOption,
  AgentProfileProjection,
  AgentProjection,
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
import { getJSON, postJSON } from "./server-http.js";
import { providerHealthData } from "./provider-health.js";
import { agentProfilesForWorkspace, profileFingerprint } from "./profiles.js";
import { deviceSystem, getDevice } from "./device.js";
import { deviceAccountIdentity } from "./device-pairing.js";
import { managedRoots } from "./personal-agent-settings.js";
import { runningWorker } from "./worker-identity.js";
import { optionValue, safeID, sizeLabel } from "./utils.js";
import {
  isForgottenWorkspaceFolder,
  readRegistry,
  readWorkspace,
  workspaceFilePath,
} from "./workspaces.js";
import { workspaceProjectionForPath } from "./issues.js";
import { status } from "./service.js";
import { ExecutionStore } from "./execution-storage.js";
import { nativeCli, outdatedNote } from "./native-cli.js";

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
        : "add .foundry/preview.json",
    },
  ];
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
  report(true, ".foundry/workspace.json");
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

/** What the server answers a chat sync; older servers name no refusals. */
interface SyncedChats {
  refused?: string[];
}

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
  // What was uploaded (by fingerprint), and the chats the server never
  // keeps (deleted, or a Foundry session owns them: its native chat changes
  // all the time it runs), are kept across restarts in the state root.
  const uploads = chatUploads(serverURL, workspace.id);
  const { uploaded, refused } = uploads;
  if (
    !uploads.reconciled &&
    (await reconcileWithServer(serverURL, workspace.id, uploads, candidates))
  )
    uploads.save();
  const remember = (answer: SyncedChats | undefined) => {
    const before = refused.size;
    for (const id of answer?.refused ?? []) refused.add(id);
    if (refused.size !== before) uploads.save();
  };
  // A chat carries content only (its time is its last activity, never a
  // label), so a chat nobody touched is never uploaded again.
  const chats = candidates
    .filter((chat) => !refused.has(chat.id))
    .filter((chat) =>
      historyIds
        ? historyIds.has(chat.id)
        : uploaded.get(chat.id) !== chatFingerprint(chat),
    );
  // Chats this worker has not sent yet go up first as summaries, a batch per
  // request, so the whole list appears at once; the server keeps any
  // transcript it already holds for an unchanged answer.
  const unseen = chats.filter((chat) => !uploaded.has(chat.id));
  for (let offset = 0; offset < unseen.length; offset += summaryBatchSize)
    remember(
      await postJSON<SyncedChats>(serverURL, "/api/daemon/chats/sync", {
        workspaceId: workspace.id,
        chats: unseen
          .slice(offset, offset + summaryBatchSize)
          .map((chat) => ({ ...chat, transcript: undefined })),
      }),
    );
  // Full detail includes typed transcripts: one chat per request so a long
  // history cannot exceed the HTTP request size limit.
  for (const chat of chats) {
    if (refused.has(chat.id)) continue;
    remember(
      await postJSON<SyncedChats>(serverURL, "/api/daemon/chats/sync", {
        workspaceId: workspace.id,
        chats: [chat],
      }),
    );
    rememberUpload(uploads, chat);
    uploads.save();
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
  "codex_active_steer",
  "issue_sessions",
  "issue_clarification",
  "worker_update",
  "worker_update_status",
  "background_skill_scan",
  "workspace_draft_skills_v1",
  "tool_install",
  "tool_sources",
  "tool_registry",
  "session_usage",
  "diagnostics",
  "skill_repository_fetch",
  "workspace_inventory",
  "workspace_git_setup",
  "verification_sessions",
  "attachment_files",
  "feishu_gateway",
  deviceConnectorsCapability,
  workspaceFoldersCapability,
  workspaceCreateCapability,
  resourcesCapability,
  resourceOperationsCapability,
  resourceComputeCapability,
  deviceSharingCapability,
];

/** A busy older host keeps running after a daemon update. Its inputs must
 * remain gated by what that execution owner actually understands. */
export function availableDaemonCapabilities(
  host:
    | Pick<ExecutionHostClient, "supportsCapability">
    | undefined = executionHostClient(),
): string[] {
  return daemonCapabilities.filter(
    (capability) =>
      capability !== "workspace_draft_skills_v1" ||
      !host ||
      host.supportsCapability(capability),
  );
}

/**
 * A hello that names every workspace the daemon serves (the
 * workspace_inventory capability): the server marks the device's other
 * workspaces unavailable on it. Those it still has but whose folder is gone
 * are named apart (the workspace_folders capability).
 */
export function withServedWorkspaces<T extends object>(
  registration: T,
  served: ReadonlyArray<{ workspace: { id: string } }>,
  missingWorkspaceIds: readonly string[] = [],
): T & { servedWorkspaceIds: string[]; missingWorkspaceIds: string[] } {
  return {
    ...registration,
    servedWorkspaceIds: served.map((item) => item.workspace.id),
    missingWorkspaceIds: [...missingWorkspaceIds],
  };
}

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
  /** The system account and machine, as hashes (device-pairing.ts). */
  identity: ReturnType<typeof deviceAccountIdentity>;
} {
  const device = getDevice();
  const workspaceProjection = workspaceProjectionForPath(workspacePath, device);
  const providerHealth = providerHealthData();
  const agentProfiles = agentProfilesForWorkspace(device, workspacePath);

  return {
    capabilities: availableDaemonCapabilities(),
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
      managedRoots: managedRoots(),
    },
    providerHealth,
    // Workspace skills come from the server's Skill library; the field stays
    // empty for servers that still expect it.
    skills: [],
    workspace: workspaceProjection,
    workspaceFiles: workspaceFilesForWorkspace(
      workspacePath,
      workspaceProjection.id,
    ),
    identity: deviceAccountIdentity(),
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
    capabilities: availableDaemonCapabilities(),
    assets: [],
    agentProfiles: agentProfilesForWorkspace(device, ""),
    agents: [],
    chats: [],
    device: {
      ...device,
      resources: discoverResources(),
      worker: runningWorker(),
      system: deviceSystem(),
      managedRoots: managedRoots(),
    },
    providerHealth: providerHealthData(),
    skills: [],
    workspaceFiles: [],
    identity: deviceAccountIdentity(),
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
 * the folder it happens to be started from never does, and neither does one
 * the person removed (a service installed with it still names it).
 */
export function daemonWorkspacePath(args: string[]): string {
  const path = optionValue(
    args,
    "--workspace",
    readDaemonConfig()?.workspacePath,
  );
  return path && !isForgottenWorkspaceFolder(path) ? resolve(path) : "";
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
