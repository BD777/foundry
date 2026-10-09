import type {
  SkillComparisonInput,
  SkillComparison,
  SkillFileComparison,
  SkillPromotionResolution,
} from "@bd777/foundry-protocol";
import type {
  SkillPromotionPlan,
  AgentBackgroundTaskOutput,
  AgentModelOption,
  AgentProfileProjection,
  AgentRuntimeSettings,
  AgentSession,
  AgentSubagentSummary,
  AgentSubagentTranscript,
  ChatAttachment,
  ChatThread,
  ChatLayout,
  DeviceProfileBinding,
  DeviceDiagnostics,
  DeviceProjection,
  DeviceRepairAction,
  DeviceRepairResult,
  DeviceResource,
  DeviceSkill,
  DeviceSkillRoot,
  PromotedSkill,
  RepositorySkillFolder,
  SkillRepository,
  SkillRepositoryView,
  SkillToolDeclaration,
  WorkspaceSkillBinding,
  ProfileDefinition,
  PromoteProfileInput,
  SaveProfileInput,
  SetDeviceProfilesInput,
  Issue,
  SessionFileDiff,
  SessionFileRead,
  WorkspaceDirectoryEntry,
  WorkspaceFileRead,
  WorkspaceFeishuConfig,
  FeishuPairingCodeResult,
  WorkspaceAccessRole,
  WorkspaceProjection,
  WorkspaceTreeEntry,
  WorkerRelease,
} from "@bd777/foundry-protocol";
import { parseProtocolEnvelopeJSON } from "@bd777/foundry-protocol";
import { issueDisplayStatus } from "./lib/issue-meta";
import type {
  CreateAgentProfileInput,
  CreateAgentSessionInput,
  SendAgentSessionMessageInput,
  CreateIssueInput,
  CreateWorkspaceInput,
  WorkspaceInspection,
  FoundryData,
  FoundryStreamEvent,
  ListWorkspaceSubdirectoriesInput,
  ReadWorkspaceFileInput,
  SaveAgentRuntimeSettingsInput,
  UploadChatAttachmentsInput,
  AccountInvite,
  AccountRole,
  AccountUser,
  AuthState,
  CreatedAccountInvite,
  InvitePreview,
  NewAccountInput,
  WorkspaceMember,
} from "./api-types";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:31982";

export interface ChatTitleMetadata {
  chatId: string;
  title: string;
  version: string;
  generationSessionId?: string;
  generationStatus?: string;
  generationError?: string;
}

export function getChatLayout(workspaceId: string): Promise<ChatLayout> {
  return getJSON(
    `/api/chat-layout?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
}

export function saveChatLayout(
  workspaceId: string,
  layout: ChatLayout,
): Promise<ChatLayout> {
  return postJSON("/api/chat-layout", {
    workspaceId,
    expectedRevision: layout.revision,
    layout,
  });
}

export function deleteChatGroup(
  workspaceId: string,
  groupId: string,
  expectedRevision: number,
): Promise<ChatLayout> {
  return postJSON("/api/chat-layout/delete-group", {
    workspaceId,
    groupId,
    expectedRevision,
  });
}

export function listChatTitles(
  workspaceId: string,
): Promise<ChatTitleMetadata[]> {
  return getJSON(
    `/api/chat-titles?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
}

export function renameChat(
  chatId: string,
  workspaceId: string,
  title: string,
): Promise<ChatTitleMetadata> {
  return postJSON(`/api/chats/${encodeURIComponent(chatId)}/title`, {
    workspaceId,
    title,
  });
}

export function recapChatTitle(
  chatId: string,
  workspaceId: string,
): Promise<AgentSession> {
  return postJSON(`/api/chats/${encodeURIComponent(chatId)}/recap-title`, {
    workspaceId,
  });
}

class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const authRequiredListeners = new Set<() => void>();

/** Subscribes to HTTP 401 answers, i.e. the login session is missing or gone. */
export function onAuthRequired(listener: () => void): () => void {
  authRequiredListeners.add(listener);
  return () => authRequiredListeners.delete(listener);
}

/**
 * Every browser API request goes through here so the HttpOnly login cookie is
 * sent, including to a separate API origin during development.
 */
export async function apiFetch(
  input: string,
  init: RequestInit = {},
  { notifyAuthRequired = true } = {},
): Promise<Response> {
  const response = await fetch(input, { ...init, credentials: "include" });
  if (response.status === 401 && notifyAuthRequired) {
    authRequiredListeners.forEach((listener) => listener());
  }
  return response;
}

export function localImageUrl(path: string): string {
  const params = new URLSearchParams({ path });
  return `${API_BASE_URL}/api/local-files/image?${params.toString()}`;
}

const foundryStreamEventTypes = new Set<FoundryStreamEvent["type"]>([
  "device_status_changed",
  "evidence_updated",
  "issue_updated",
  "issue_run_event",
  "agent_session_created",
  "agent_session_started",
  "agent_session_event",
  "agent_session_completed",
  "agent_session_native_session_id",
  "feishu_bot_updated",
  "workspace_members_updated",
]);

export function subscribeFoundryEvents(
  onEvent: (event: FoundryStreamEvent) => void,
  lifecycle: { onError?: () => void; onOpen?: () => void } = {},
): () => void {
  const source = new EventSource(`${API_BASE_URL}/api/events`, {
    withCredentials: true,
  });
  source.onopen = () => lifecycle.onOpen?.();
  source.onerror = () => lifecycle.onError?.();
  source.onmessage = (message) => {
    try {
      const event = parseProtocolEnvelopeJSON(
        message.data,
      ) as FoundryStreamEvent;
      if (event?.payload && foundryStreamEventTypes.has(event.type)) {
        onEvent(event);
      }
    } catch {
      // A later persisted snapshot repairs malformed or interrupted stream data.
    }
  };
  return () => source.close();
}

export const emptyWorkspace: WorkspaceProjection = {
  id: "",
  name: "No workspace",
  localPath: "Run local daemon setup",
  baseline: "main",
  contextSummary: "No local daemon has registered a workspace yet.",
  acceptedCount: 0,
  resolvedCount: 0,
};

export interface RequestOptions {
  signal?: AbortSignal;
}

/** Distinguishes caller-driven cancellation from transport failure. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function getJSON<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await apiFetch(`${API_BASE_URL}${path}`, {
    headers: jsonHeaders(false),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new ApiError(
      await responseErrorMessage(response, path),
      response.status,
    );
  }
  return (await response.json()) as T;
}

async function postJSON<T>(
  path: string,
  body?: unknown,
  idempotencyKey?: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await apiFetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    signal: options.signal,
    headers: {
      ...jsonHeaders(true),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new ApiError(
      await responseErrorMessage(response, path),
      response.status,
    );
  }
  return (await response.json()) as T;
}

async function deleteJSON<T>(path: string): Promise<T> {
  const response = await apiFetch(`${API_BASE_URL}${path}`, {
    method: "DELETE",
    headers: jsonHeaders(false),
  });
  if (!response.ok) {
    throw new ApiError(
      await responseErrorMessage(response, path),
      response.status,
    );
  }
  return (await response.json()) as T;
}

async function putJSON<T>(path: string, body?: unknown): Promise<T> {
  const response = await apiFetch(`${API_BASE_URL}${path}`, {
    method: "PUT",
    headers: jsonHeaders(true),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new ApiError(
      await responseErrorMessage(response, path),
      response.status,
    );
  }
  return (await response.json()) as T;
}

async function patchJSON<T>(path: string, body: unknown): Promise<T> {
  const response = await apiFetch(`${API_BASE_URL}${path}`, {
    method: "PATCH",
    headers: jsonHeaders(true),
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new ApiError(
      await responseErrorMessage(response, path),
      response.status,
    );
  return (await response.json()) as T;
}

/** Authentication rides on the session cookie that apiFetch always sends. */
function jsonHeaders(includeContentType: boolean): Record<string, string> {
  return includeContentType ? { "Content-Type": "application/json" } : {};
}

async function responseErrorMessage(
  response: Response,
  path: string,
): Promise<string> {
  try {
    const payload = (await response.clone().json()) as { error?: string };
    if (payload.error) {
      return payload.error;
    }
  } catch {
    // Fall back to status text below.
  }
  const detail = await response.text();
  if (detail.trim() && !detail.trimStart().startsWith("<"))
    return detail.trim().slice(0, 2000);
  return `${path} returned ${response.status}`;
}

export async function loadFoundryData(
  activeWorkspaceId?: string,
  options: RequestOptions = {},
): Promise<FoundryDataLoadResult> {
  const query = activeWorkspaceId
    ? `?workspaceId=${encodeURIComponent(activeWorkspaceId)}`
    : "";
  try {
    return await getFoundryData(`/api/foundry-data${query}`, options);
  } catch (error) {
    if (
      activeWorkspaceId &&
      error instanceof ApiError &&
      error.status === 404
    ) {
      return getFoundryData("/api/foundry-data", options);
    }
    throw error;
  }
}

export interface FoundryDataLoadResult {
  data: FoundryData;
  notModified: boolean;
}

// Warm only the row the user points at or focuses. Consume each result once so
// a later visit cannot keep reusing a stale workspace snapshot.
const workspacePreloads = new Map<
  string,
  {
    startedAt: number;
    result: Promise<FoundryDataLoadResult | undefined>;
  }
>();
const workspacePreloadTTL = 5_000;

export function prefetchFoundryWorkspace(workspaceId: string): void {
  if (!workspaceId) return;
  const existing = workspacePreloads.get(workspaceId);
  if (existing && Date.now() - existing.startedAt < workspacePreloadTTL) return;
  if (workspacePreloads.size >= 4) {
    workspacePreloads.delete(workspacePreloads.keys().next().value!);
  }
  workspacePreloads.set(workspaceId, {
    startedAt: Date.now(),
    result: loadFoundryData(workspaceId).catch(() => undefined),
  });
}

export async function loadFoundryWorkspace(
  workspaceId: string,
  options: RequestOptions = {},
): Promise<FoundryDataLoadResult> {
  const preloaded = workspacePreloads.get(workspaceId);
  workspacePreloads.delete(workspaceId);
  if (preloaded && Date.now() - preloaded.startedAt < workspacePreloadTTL) {
    const result = await preloaded.result;
    options.signal?.throwIfAborted();
    if (result) return result;
  }
  return loadFoundryData(workspaceId, options);
}

const foundryDataCache = new Map<string, { data: FoundryData; etag: string }>();

async function getFoundryData(
  path: string,
  options: RequestOptions,
): Promise<FoundryDataLoadResult> {
  const cached = foundryDataCache.get(path);
  const headers = jsonHeaders(false);
  if (cached?.etag) {
    headers["If-None-Match"] = cached.etag;
  }
  const response = await apiFetch(`${API_BASE_URL}${path}`, {
    headers,
    signal: options.signal,
  });
  if (response.status === 304 && cached) {
    return { data: cached.data, notModified: true };
  }
  if (!response.ok) {
    throw new ApiError(
      await responseErrorMessage(response, path),
      response.status,
    );
  }
  const data = (await response.json()) as FoundryData;
  data.issues = (data.issues ?? []).map((issue) => ({
    ...issue,
    status: issueDisplayStatus(issue),
  }));
  // Older servers omit the skill-isolation collections; default to empty so
  // the new UI treats them as "nothing configured" rather than undefined.
  data.deviceSkillRoots ??= [];
  data.promotedSkills ??= [];
  data.workspaceSkillBindings ??= [];
  const etag = response.headers.get("ETag") ?? "";
  if (etag) {
    foundryDataCache.set(path, { data, etag });
  }
  return { data, notModified: false };
}

export function inspectWorkspace(
  workspaceId: string,
  rescan = false,
): Promise<WorkspaceInspection> {
  const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/inspection`;
  return rescan
    ? postJSON<WorkspaceInspection>(`${path}/rescan`)
    : getJSON<WorkspaceInspection>(path);
}

export function createIssue(
  input: CreateIssueInput,
  idempotencyKey = crypto.randomUUID(),
): Promise<Issue> {
  return postJSON<Issue>("/api/issues", input, idempotencyKey);
}

export function createWorkspace(
  input: CreateWorkspaceInput,
): Promise<WorkspaceProjection> {
  return postJSON<WorkspaceProjection>("/api/workspaces", input);
}

export async function deleteWorkspace(
  workspaceId: string,
): Promise<WorkspaceProjection> {
  const workspace = await deleteJSON<WorkspaceProjection>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}`,
  );
  workspacePreloads.clear();
  return workspace;
}

/**
 * Soft-remove a device: the server tombstones it (history and credentials are
 * kept) and drops its live daemon connection so it cannot reappear.
 */
export async function removeDevice(
  deviceId: string,
): Promise<DeviceProjection> {
  const device = await deleteJSON<DeviceProjection>(
    `/api/devices/${encodeURIComponent(deviceId)}`,
  );
  workspacePreloads.clear();
  return device;
}

/** Asks a device's worker to update itself to this server's version. */
/** Asks a device's worker for a report on itself (no model requests). */
export function runDeviceDiagnostics(
  deviceId: string,
): Promise<DeviceDiagnostics> {
  return postJSON<DeviceDiagnostics>(
    `/api/devices/${encodeURIComponent(deviceId)}/diagnostics`,
    {},
  );
}

/** Runs one repair the person chose on a device's worker. */
export function runDeviceRepair(
  deviceId: string,
  action: DeviceRepairAction,
): Promise<DeviceRepairResult> {
  return postJSON<DeviceRepairResult>(
    `/api/devices/${encodeURIComponent(deviceId)}/repairs`,
    { action },
  );
}

export function updateDeviceWorker(
  deviceId: string,
): Promise<{ log?: string }> {
  return postJSON(
    `/api/devices/${encodeURIComponent(deviceId)}/worker/update`,
    {},
  );
}

/** Gives a device the name people see; its hostname stays in `system`. */
export function renameDevice(
  deviceId: string,
  name: string,
): Promise<DeviceProjection> {
  return patchJSON<DeviceProjection>(
    `/api/devices/${encodeURIComponent(deviceId)}`,
    { name },
  );
}

export async function renameWorkspace(
  workspaceId: string,
  name: string,
): Promise<WorkspaceProjection> {
  const workspace = await patchJSON<WorkspaceProjection>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}`,
    { name },
  );
  workspacePreloads.clear();
  return workspace;
}

export function listWorkspaceSubdirectories(
  input: ListWorkspaceSubdirectoriesInput,
): Promise<WorkspaceDirectoryEntry[]> {
  return postJSON<WorkspaceDirectoryEntry[]>(
    "/api/workspaces/subdirectories",
    input,
  );
}

export function acceptIssue(
  issueId: string,
  revision?: number,
): Promise<Issue> {
  return Promise.reject(
    new Error(
      "Open Evidence & Verify, review the exact candidate, and Accept its review snapshot. Environment revision is no longer sufficient.",
    ),
  );
}

export interface CandidateReviewData {
  status: string;
  revision: number;
  review: {
    cwd: string;
    repositories: Array<{
      path: string;
      baseline: string;
      candidate?: string;
      diff: string;
      truncated: boolean;
    }>;
  };
}

export interface IssueEnvironmentData {
  status: string;
  cwd?: string;
  revision?: number;
  bytes?: number;
  files?: number;
  error?: string;
  hasPreview?: boolean;
  preview?: { state: string; url?: string; error?: string };
  content?: {
    tracked: string[];
    untracked: string[];
    ignored: string[];
    truncated: boolean;
  };
  repositories: Array<{
    path: string;
    kind?: string;
    status: string;
    availability?: string;
    error?: string;
  }>;
}
export async function readIssueEnvironment(
  issueId: string,
): Promise<IssueEnvironmentData> {
  const result = await getJSON<{ environment: IssueEnvironmentData }>(
    `/api/issues/${encodeURIComponent(issueId)}/environment`,
  );
  return result.environment;
}
export function issueEnvironmentAction(
  issueId: string,
  action: "cancel" | "cleanup" | "preview_start" | "preview_stop",
): Promise<unknown> {
  return postJSON(
    `/api/issues/${encodeURIComponent(issueId)}/environment/${action}`,
    {},
  );
}

export function readCandidateReview(
  issueId: string,
): Promise<CandidateReviewData> {
  return getJSON(`/api/issues/${encodeURIComponent(issueId)}/candidate-review`);
}

export function steerIssue(
  issueId: string,
  message: string,
  expectedRunId: string,
): Promise<unknown> {
  return postJSON(
    `/api/issues/${encodeURIComponent(issueId)}/environment/steer`,
    { message, expectedRunId },
  );
}

export function abandonIssue(
  issueId: string,
  expectedRunId?: string,
): Promise<Issue> {
  return postJSON(`/api/issues/${encodeURIComponent(issueId)}/abandon`, {
    expectedRunId: expectedRunId ?? "",
  });
}

/** Answers the question an Issue's execution asked; the Issue continues in its candidate. */
export function answerIssueQuestion(
  issueId: string,
  questionId: string,
  answer: string,
): Promise<Issue> {
  return postJSON<Issue>(`/api/issues/${issueId}/answer`, {
    questionId,
    answer,
  });
}

export function requestChanges(
  issueId: string,
  message?: string,
  expectedRunId?: string,
): Promise<Issue> {
  return postJSON<Issue>(`/api/issues/${issueId}/request-changes`, {
    message,
    expectedRunId,
  });
}

export function readWorkspaceFile(
  input: ReadWorkspaceFileInput,
  options: RequestOptions = {},
): Promise<WorkspaceFileRead> {
  const params = new URLSearchParams({
    path: input.path,
    workspaceId: input.workspaceId,
  });
  return getJSON<WorkspaceFileRead>(
    `/api/workspace-files/read?${params.toString()}`,
    options,
  );
}

/** One of a session's recorded files, read from its device. */
export function readSessionFile(
  sessionId: string,
  path: string,
  options: RequestOptions = {},
): Promise<SessionFileRead> {
  const params = new URLSearchParams({ path });
  return getJSON<SessionFileRead>(
    `/api/agent-sessions/${encodeURIComponent(sessionId)}/files/read?${params.toString()}`,
    options,
  );
}

/** What the session's writes changed in one of its files; one turn's with `inputId`. */
export function readSessionFileDiff(
  sessionId: string,
  path: string,
  inputId?: string,
  options: RequestOptions = {},
): Promise<SessionFileDiff> {
  const params = new URLSearchParams({ path });
  if (inputId) params.set("inputId", inputId);
  return getJSON<SessionFileDiff>(
    `/api/agent-sessions/${encodeURIComponent(sessionId)}/files/diff?${params.toString()}`,
    options,
  );
}

/** The end of a background task's output and its command (members). */
export function readBackgroundTaskOutput(
  sessionId: string,
  taskId: string,
  options: RequestOptions = {},
): Promise<AgentBackgroundTaskOutput> {
  return getJSON<AgentBackgroundTaskOutput>(
    `/api/agent-sessions/${encodeURIComponent(sessionId)}/background-tasks/${encodeURIComponent(taskId)}/output`,
    options,
  );
}

/** Asks the session's agent to stop one of its background tasks. */
export function stopBackgroundTask(
  sessionId: string,
  taskId: string,
): Promise<{ sessionId: string; taskId: string; stopping: boolean }> {
  return postJSON(
    `/api/agent-sessions/${encodeURIComponent(sessionId)}/background-tasks/${encodeURIComponent(taskId)}/stop`,
  );
}

export function listWorkspaceTree(
  input: { workspaceId: string; path?: string },
  options: RequestOptions = {},
): Promise<WorkspaceTreeEntry[]> {
  const params = new URLSearchParams({
    path: input.path ?? "",
    workspaceId: input.workspaceId,
  });
  return getJSON<WorkspaceTreeEntry[]>(
    `/api/workspace-files/tree?${params.toString()}`,
    options,
  );
}

export function readAgentSubagentTranscript(
  sessionId: string,
  taskId: string,
  options: RequestOptions = {},
): Promise<AgentSubagentTranscript> {
  return getJSON<AgentSubagentTranscript>(
    `/api/agent-sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(taskId)}`,
    options,
  );
}

export function listAgentSubagents(
  sessionId: string,
  options: RequestOptions = {},
): Promise<AgentSubagentSummary[]> {
  return getJSON<AgentSubagentSummary[]>(
    `/api/agent-sessions/${encodeURIComponent(sessionId)}/subagents`,
    options,
  );
}

export async function uploadChatAttachments(
  input: UploadChatAttachmentsInput,
): Promise<ChatAttachment[]> {
  const body = new FormData();
  body.set("workspaceId", input.workspaceId);
  input.files.forEach((file) => body.append("files", file));
  const response = await apiFetch(`${API_BASE_URL}/api/attachments`, {
    method: "POST",
    headers: jsonHeaders(false),
    body,
  });
  if (!response.ok) {
    throw new Error(`/api/attachments returned ${response.status}`);
  }
  return (await response.json()) as ChatAttachment[];
}

export function createAgentSession(
  input: CreateAgentSessionInput,
  idempotencyKey?: string,
): Promise<AgentSession> {
  return postJSON<AgentSession>("/api/agent-sessions", input, idempotencyKey);
}

export function getAgentSession(
  sessionId: string,
  options: RequestOptions = {},
): Promise<AgentSession> {
  return getJSON<AgentSession>(
    `/api/agent-sessions/${encodeURIComponent(sessionId)}`,
    options,
  );
}

/** The sessions that worked for one Issue, oldest first as the server lists them. */
export function listIssueSessions(
  workspaceId: string,
  issueId: string,
): Promise<AgentSession[]> {
  const params = new URLSearchParams({ workspaceId, issueId });
  return getJSON<AgentSession[]>(`/api/agent-sessions?${params.toString()}`);
}

export function getAgentSessionThread(
  threadId: string,
  workspaceId: string,
  options: RequestOptions = {},
): Promise<AgentSession[]> {
  const params = new URLSearchParams({ workspaceId });
  return getJSON<AgentSession[]>(
    `/api/agent-session-threads/${encodeURIComponent(threadId)}?${params.toString()}`,
    options,
  );
}

export function getChat(
  chatId: string,
  options: RequestOptions = {},
): Promise<ChatThread> {
  return getJSON<ChatThread>(
    `/api/chats/${encodeURIComponent(chatId)}`,
    options,
  );
}

export function sendAgentSessionMessage(
  sessionId: string,
  input: SendAgentSessionMessageInput,
  idempotencyKey?: string,
): Promise<AgentSession> {
  return postJSON<AgentSession>(
    `/api/agent-sessions/${encodeURIComponent(sessionId)}/messages`,
    input,
    idempotencyKey,
  );
}

export function cancelAgentSession(sessionId: string): Promise<AgentSession> {
  return postJSON<AgentSession>(
    `/api/agent-sessions/${encodeURIComponent(sessionId)}/cancel`,
  );
}

export function createAgentProfile(
  input: CreateAgentProfileInput,
): Promise<AgentProfileProjection> {
  return postJSON<AgentProfileProjection>("/api/agent-profiles", input);
}

export function listAgentModels(
  profile: CreateAgentProfileInput,
): Promise<AgentModelOption[]> {
  return postJSON<AgentModelOption[]>("/api/agent-profiles/models", {
    profile,
  });
}

export function listProfiles(): Promise<ProfileDefinition[]> {
  return getJSON<ProfileDefinition[]>("/api/profiles");
}

/** Run the official installer for Claude Code or Codex on a device. */
export function installDeviceCli(
  deviceId: string,
  runtime: "claude" | "codex",
): Promise<import("@bd777/foundry-protocol").NativeCliInstallResult> {
  return postJSON(
    `/api/devices/${encodeURIComponent(deviceId)}/accounts/${runtime}/install`,
    {},
  );
}

export function inspectDeviceAccount(
  deviceId: string,
  runtime: "claude" | "codex",
  source?: string,
): Promise<import("@bd777/foundry-protocol").NativeAccountInspection> {
  return postJSON(
    `/api/devices/${encodeURIComponent(deviceId)}/accounts/${runtime}/inspect`,
    { source },
  );
}

export function createProfile(
  input: SaveProfileInput,
): Promise<ProfileDefinition> {
  return postJSON<ProfileDefinition>("/api/profiles", input);
}

export function updateProfile(
  id: string,
  input: SaveProfileInput,
): Promise<ProfileDefinition> {
  return putJSON<ProfileDefinition>(
    `/api/profiles/${encodeURIComponent(id)}`,
    input,
  );
}

export function deleteProfile(id: string): Promise<ProfileDefinition> {
  return deleteJSON<ProfileDefinition>(
    `/api/profiles/${encodeURIComponent(id)}`,
  );
}

export function clearProfileCredential(id: string): Promise<ProfileDefinition> {
  return postJSON<ProfileDefinition>(
    `/api/profiles/${encodeURIComponent(id)}/credential/clear`,
  );
}

export function promoteProfile(
  input: PromoteProfileInput,
): Promise<ProfileDefinition> {
  return postJSON<ProfileDefinition>("/api/profiles/promote", input);
}

export function setDeviceProfiles(
  input: SetDeviceProfilesInput,
): Promise<DeviceProfileBinding[]> {
  return putJSON<DeviceProfileBinding[]>(
    `/api/devices/${encodeURIComponent(input.deviceId)}/profiles`,
    input,
  );
}

export function saveAgentRuntimeSettings(
  input: SaveAgentRuntimeSettingsInput,
): Promise<AgentRuntimeSettings> {
  return postJSON<AgentRuntimeSettings>("/api/devices/runtime-settings", input);
}

export interface RefreshedDeviceResources {
  resources: DeviceResource[];
  /** System settings panes the device opened for its person. */
  opened: string[];
}

/**
 * Has a device detect its resources again; with requestAccess, it first asks
 * the person at the device for access to that resource.
 */
export function refreshDeviceResources(
  deviceId: string,
  requestAccess?: string,
): Promise<RefreshedDeviceResources> {
  return postJSON<RefreshedDeviceResources>(
    `/api/devices/${encodeURIComponent(deviceId)}/resources/refresh`,
    requestAccess ? { requestAccess } : {},
  );
}

export function resetDemoData(): Promise<{ status: string }> {
  return postJSON<{ status: string }>("/api/dev/reset-demo", {});
}

// --- Workspace skill isolation ---

export interface DeviceSkillsSnapshot {
  roots: DeviceSkillRoot[];
  skills: DeviceSkill[];
}

export function listDeviceSkills(
  deviceId: string,
): Promise<DeviceSkillsSnapshot> {
  return getJSON<DeviceSkillsSnapshot>(
    `/api/device-skills?deviceId=${encodeURIComponent(deviceId)}`,
  );
}

export function scanDeviceSkills(deviceId: string): Promise<DeviceSkill[]> {
  return postJSON<DeviceSkill[]>(
    `/api/device-skills/scan?deviceId=${encodeURIComponent(deviceId)}`,
    {},
  );
}

export function setDeviceSkillRoots(
  deviceId: string,
  paths: string[],
): Promise<DeviceSkillRoot[]> {
  return putJSON<DeviceSkillRoot[]>(
    `/api/devices/${encodeURIComponent(deviceId)}/skill-roots`,
    { deviceId, paths },
  );
}

export function promoteSkill(input: {
  deviceId: string;
  root: string;
  dirName: string;
  resolutions?: SkillPromotionResolution[];
  planDigest?: string;
  includeRelated?: string[];
}): Promise<PromotedSkill> {
  return postJSON<PromotedSkill>("/api/skills/promote", input);
}

export function listPromotedSkills(): Promise<PromotedSkill[]> {
  return getJSON<PromotedSkill[]>("/api/skills/catalog");
}

export function deletePromotedSkill(skillId: string): Promise<void> {
  return deleteJSON<void>(`/api/skills/catalog/${encodeURIComponent(skillId)}`);
}

export function listWorkspaceSkills(
  workspaceId: string,
): Promise<WorkspaceSkillBinding[]> {
  return getJSON<WorkspaceSkillBinding[]>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/skills`,
  );
}

/** Holds a workspace's skill at one revision; 0 follows the latest again. */
export function setWorkspaceSkillPin(
  workspaceId: string,
  skillId: string,
  revision: number,
): Promise<WorkspaceSkillBinding[]> {
  return putJSON<WorkspaceSkillBinding[]>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(skillId)}/pin`,
    { revision },
  );
}

/** The library skills the signed-in person gives every workspace they own. */
export interface MyDefaultSkills {
  skillIds: string[];
  bundleIds?: string[];
}

export function listMyDefaultSkills(): Promise<MyDefaultSkills> {
  return getJSON<MyDefaultSkills>("/api/me/default-skills");
}

/** Replaces the default skills, and the default bundles when given. */
export function setMyDefaultSkills(
  skillIds: string[],
  bundleIds?: string[],
): Promise<MyDefaultSkills> {
  return putJSON<MyDefaultSkills>("/api/me/default-skills", {
    skillIds,
    ...(bundleIds ? { bundleIds } : {}),
  });
}

// --- Skill repositories ---

export function listSkillRepositories(): Promise<SkillRepository[]> {
  return getJSON<SkillRepository[]>("/api/skill-repositories");
}

export interface SkillRepositoryPreview {
  label: string;
  name: string;
  available: RepositorySkillFolder[];
  /** The skills look like one set (shared name prefix or a manifest). */
  suggestBundle: boolean;
  /** The newest release tag, when the repository has one. */
  release?: string;
}

/** Where a repository is read: a device ("" is the server) and its npm registry. */
export interface SkillRepositorySource {
  deviceId?: string;
  registry?: string;
}

/** Reads a repository without following it. */
export function previewSkillRepository(
  input: {
    url: string;
    ref: string;
    subpath: string;
  } & SkillRepositorySource,
): Promise<SkillRepositoryPreview> {
  const query = new URLSearchParams(
    Object.entries(input).filter((entry): entry is [string, string] =>
      Boolean(entry[1]),
    ),
  ).toString();
  return getJSON<SkillRepositoryPreview>(
    `/api/skill-repositories/preview?${query}`,
  );
}

/** Follows a repository: chosen skills (pick) or all of it (bundle). */
export function addSkillRepository(
  input: {
    url: string;
    ref: string;
    subpath: string;
    mode?: "pick" | "bundle";
    dirs?: string[];
    /** The bundle's name; the server derives one when empty. */
    name?: string;
    /** Programs a bundle needs that its source does not publish. */
    tools?: SkillToolDeclaration[];
  } & SkillRepositorySource,
): Promise<SkillRepositoryView> {
  return postJSON<SkillRepositoryView>("/api/skill-repositories", input);
}

/** Changes where a followed repository is read, and checks it there. */
export function setSkillRepositorySource(
  id: string,
  source: SkillRepositorySource,
): Promise<SkillRepository> {
  return putJSON<SkillRepository>(
    `/api/skill-repositories/${encodeURIComponent(id)}/source`,
    { deviceId: source.deviceId ?? "", registry: source.registry ?? "" },
  );
}

export function rollbackSkillBundle(
  id: string,
  seq: number,
): Promise<SkillRepository> {
  return postJSON<SkillRepository>(
    `/api/skill-repositories/${encodeURIComponent(id)}/rollback`,
    { seq },
  );
}

/** Turns a repository followed by picking skills into a bundle. */
export function followRepositoryAsBundle(id: string): Promise<SkillRepository> {
  return postJSON<SkillRepository>(
    `/api/skill-repositories/${encodeURIComponent(id)}/mode`,
    { mode: "bundle" },
  );
}

export function resumeSkillBundle(id: string): Promise<SkillRepository> {
  return postJSON<SkillRepository>(
    `/api/skill-repositories/${encodeURIComponent(id)}/resume`,
    {},
  );
}

export function setWorkspaceSkillBundles(
  workspaceId: string,
  bundleIds: string[],
): Promise<{ bundleIds: string[] }> {
  return putJSON<{ bundleIds: string[] }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/skill-bundles`,
    { bundleIds },
  );
}

/** Installs a bundle's tool on a device; only on the person's request. */
/** Installs a bundle's tool on a device, or with step "setup" runs the
 * tool's setup step there and returns its output. */
export function installDeviceTool(
  deviceId: string,
  repositoryId: string,
  tool: string,
  step: "install" | "setup" = "install",
): Promise<{ name: string; version: string; output?: string }> {
  return postJSON<{ name: string; version: string; output?: string }>(
    `/api/devices/${encodeURIComponent(deviceId)}/tools/install`,
    { repositoryId, tool, step },
  );
}

export function listRepositorySkills(id: string): Promise<SkillRepositoryView> {
  return getJSON<SkillRepositoryView>(
    `/api/skill-repositories/${encodeURIComponent(id)}/skills`,
  );
}

export function importRepositorySkills(
  id: string,
  dirs: string[],
): Promise<SkillRepository> {
  return postJSON<SkillRepository>(
    `/api/skill-repositories/${encodeURIComponent(id)}/import`,
    { dirs },
  );
}

export function checkSkillRepository(id: string): Promise<SkillRepository> {
  return postJSON<SkillRepository>(
    `/api/skill-repositories/${encodeURIComponent(id)}/check`,
    {},
  );
}

export function removeSkillRepository(id: string): Promise<void> {
  return deleteJSON<void>(`/api/skill-repositories/${encodeURIComponent(id)}`);
}

export function setWorkspaceSkills(
  workspaceId: string,
  skillIds: string[],
  offSkillIds?: string[],
): Promise<WorkspaceSkillBinding[]> {
  return putJSON<WorkspaceSkillBinding[]>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/skills`,
    { workspaceId, skillIds, offSkillIds },
  );
}

export function previewSkillPromotion(input: {
  deviceId: string;
  root: string;
  dirName: string;
  includeRelated?: string[];
  resolutions?: SkillPromotionResolution[];
}): Promise<SkillPromotionPlan> {
  return postJSON<SkillPromotionPlan>("/api/skills/promote-plan", input);
}

export function compareSkillVersions(
  input: SkillComparisonInput,
  options: RequestOptions = {},
): Promise<SkillComparison> {
  return postJSON("/api/skills/compare", input, undefined, options);
}
export function compareSkillFile(
  input: SkillComparisonInput & { path: string },
  options: RequestOptions = {},
): Promise<SkillFileComparison> {
  return postJSON("/api/skills/compare-file", input, undefined, options);
}
export async function downloadSkillComparisonPackage(
  input: SkillComparisonInput & { side: "local" | "server" },
): Promise<Blob> {
  const response = await apiFetch(
    `${API_BASE_URL}/api/skills/compare-package`,
    {
      method: "POST",
      headers: jsonHeaders(true),
      body: JSON.stringify(input),
    },
  );
  if (!response.ok)
    throw new ApiError(
      await responseErrorMessage(response, "skill archive"),
      response.status,
    );
  return response.blob();
}

// --- Feishu Bot integration ---

export function getWorkspaceFeishuBot(
  workspaceId: string,
): Promise<WorkspaceFeishuConfig> {
  return getJSON<WorkspaceFeishuConfig>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/feishu`,
  );
}

export function saveWorkspaceFeishuBot(
  workspaceId: string,
  input: { appId: string; appSecret?: string },
): Promise<WorkspaceFeishuConfig> {
  return postJSON<WorkspaceFeishuConfig>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/feishu`,
    input,
  );
}

export function generateFeishuPairingCode(
  workspaceId: string,
): Promise<FeishuPairingCodeResult> {
  return postJSON<FeishuPairingCodeResult>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/feishu/pair-code`,
    {},
  );
}

export function unbindFeishuGroup(
  workspaceId: string,
): Promise<WorkspaceFeishuConfig> {
  return postJSON<WorkspaceFeishuConfig>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/feishu/unbind`,
    {},
  );
}

export function deleteWorkspaceFeishuBot(workspaceId: string): Promise<void> {
  return deleteJSON<void>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/feishu`,
  );
}

// --- Accounts ---

/**
 * Account calls answer 401 for a wrong password, which is not a lost session,
 * so they do not notify auth-required listeners. 204 resolves to undefined.
 */
async function accountRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await apiFetch(
    `${API_BASE_URL}${path}`,
    {
      method,
      headers: jsonHeaders(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { notifyAuthRequired: false },
  );
  if (!response.ok) {
    throw new ApiError(
      await responseErrorMessage(response, path),
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function getAuthState(): Promise<AuthState> {
  return accountRequest("GET", "/api/auth/state");
}

export function setupFirstOwner(
  input: NewAccountInput & { setupCode: string },
): Promise<AuthState> {
  return accountRequest("POST", "/api/auth/setup", input);
}

export function login(username: string, password: string): Promise<AuthState> {
  return accountRequest("POST", "/api/auth/login", { username, password });
}

export function logout(): Promise<void> {
  return accountRequest("POST", "/api/auth/logout");
}

export function updateMyDisplayName(displayName: string): Promise<AccountUser> {
  return accountRequest("PATCH", "/api/auth/me", { displayName });
}

export function updateMyLocale(
  locale: "" | "en" | "zh-CN",
): Promise<AccountUser> {
  return accountRequest("PATCH", "/api/auth/me", { locale });
}

export function changeMyPassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  return accountRequest("POST", "/api/auth/me/password", {
    currentPassword,
    newPassword,
  });
}

export function getInvite(token: string): Promise<InvitePreview> {
  return accountRequest(
    "GET",
    `/api/auth/invites/${encodeURIComponent(token)}`,
  );
}

export function acceptInvite(
  token: string,
  input: NewAccountInput,
): Promise<AuthState> {
  return accountRequest(
    "POST",
    `/api/auth/invites/${encodeURIComponent(token)}/accept`,
    input,
  );
}

export function listUsers(): Promise<AccountUser[]> {
  return accountRequest("GET", "/api/users");
}

export function updateUser(
  id: string,
  update: { role?: AccountRole; disabled?: boolean },
): Promise<AccountUser> {
  return accountRequest(
    "PATCH",
    `/api/users/${encodeURIComponent(id)}`,
    update,
  );
}

export function listInvites(): Promise<AccountInvite[]> {
  return accountRequest("GET", "/api/invites");
}

export function createInvite(
  role: AccountRole,
  workspace?: { workspaceId: string; workspaceRole: WorkspaceAccessRole },
): Promise<CreatedAccountInvite> {
  return accountRequest("POST", "/api/invites", { role, ...workspace });
}

// --- Workspace sharing ---

function membersPath(workspaceId: string, userId?: string): string {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/members`;
  return userId ? `${base}/${encodeURIComponent(userId)}` : base;
}

export function listWorkspaceMembers(
  workspaceId: string,
): Promise<WorkspaceMember[]> {
  return accountRequest("GET", membersPath(workspaceId));
}

export function addWorkspaceMember(
  workspaceId: string,
  username: string,
  role: WorkspaceAccessRole,
): Promise<void> {
  return accountRequest("POST", membersPath(workspaceId), { username, role });
}

export function updateWorkspaceMember(
  workspaceId: string,
  userId: string,
  role: WorkspaceAccessRole,
): Promise<void> {
  return accountRequest("PATCH", membersPath(workspaceId, userId), { role });
}

export function removeWorkspaceMember(
  workspaceId: string,
  userId: string,
): Promise<void> {
  return accountRequest("DELETE", membersPath(workspaceId, userId));
}

export function revokeInvite(id: string): Promise<void> {
  return accountRequest("DELETE", `/api/invites/${encodeURIComponent(id)}`);
}

// --- Devices ---

/** The server URL a worker on another machine should use. */
export function workerServerURL(): string {
  return API_BASE_URL || window.location.origin;
}

/** Where this server's worker comes from: its own packages, or npm. */
export function getWorkerRelease(): Promise<WorkerRelease> {
  return accountRequest("GET", "/api/worker/release");
}

export function createDevicePairingToken(): Promise<{
  token: string;
  expiresAt: string;
}> {
  return accountRequest("POST", "/api/devices/pairing-tokens", {});
}
