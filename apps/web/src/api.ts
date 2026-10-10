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
  ChatQueue,
  ChatThread,
  ChatLayout,
  EditChatQueueItemInput,
  EnqueueChatMessageInput,
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
  FoundryDataField,
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

export function getChatLayout(
  workspaceId: string,
  options: RequestOptions = {},
): Promise<ChatLayout> {
  return getJSON(
    `/api/chat-layout?workspaceId=${encodeURIComponent(workspaceId)}`,
    options,
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
  options: RequestOptions = {},
): Promise<ChatTitleMetadata[]> {
  return getJSON(
    `/api/chat-titles?workspaceId=${encodeURIComponent(workspaceId)}`,
    options,
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

/**
 * How a change to a chat's queue went. A refusal (409) carries the queue as
 * the server has it now and why: the message was already sent ("already_sent"),
 * is being sent ("sending"), or the queue changed ("changed").
 */
export type ChatQueueResult =
  | { ok: true; queue: ChatQueue }
  | {
      ok: false;
      status: number;
      error: string;
      code?: "already_sent" | "sending" | "changed";
      queue?: ChatQueue;
    };

async function chatQueueRequest(
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
  options: RequestOptions = {},
): Promise<ChatQueueResult> {
  const response = await apiFetch(`${API_BASE_URL}${path}`, {
    method,
    signal: options.signal,
    headers: {
      ...jsonHeaders(body !== undefined),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => undefined)) as
    | (ChatQueue & {
        error?: string;
        code?: "already_sent" | "sending" | "changed";
        queue?: ChatQueue;
      })
    | undefined;
  if (response.ok && payload) return { ok: true, queue: payload };
  return {
    ok: false,
    status: response.status,
    error: payload?.error ?? `${path} returned ${response.status}`,
    code: payload?.code,
    queue: payload?.queue,
  };
}

function chatQueuePath(chatId: string, rest = ""): string {
  return `/api/chats/${encodeURIComponent(chatId)}/queue${rest}`;
}

export function getChatQueue(
  chatId: string,
  options: RequestOptions = {},
): Promise<ChatQueueResult> {
  return chatQueueRequest(
    "GET",
    chatQueuePath(chatId),
    undefined,
    undefined,
    options,
  );
}

/** The idempotency key makes a repeated request (a reload, another tab) add the message once. */
export function enqueueChatMessage(
  chatId: string,
  input: EnqueueChatMessageInput,
  idempotencyKey: string,
): Promise<ChatQueueResult> {
  return chatQueueRequest("POST", chatQueuePath(chatId), input, idempotencyKey);
}

export function editChatQueueItem(
  chatId: string,
  itemId: string,
  input: EditChatQueueItemInput,
): Promise<ChatQueueResult> {
  return chatQueueRequest(
    "PATCH",
    chatQueuePath(chatId, `/${encodeURIComponent(itemId)}`),
    input,
  );
}

export function deleteChatQueueItem(
  chatId: string,
  itemId: string,
): Promise<ChatQueueResult> {
  return chatQueueRequest(
    "DELETE",
    chatQueuePath(chatId, `/${encodeURIComponent(itemId)}`),
  );
}

export function reorderChatQueue(
  chatId: string,
  itemIds: string[],
  expectedRevision: number,
): Promise<ChatQueueResult> {
  return chatQueueRequest("PUT", chatQueuePath(chatId, "/order"), {
    itemIds,
    expectedRevision,
  });
}

export function steerChatQueueItem(
  chatId: string,
  itemId: string,
): Promise<ChatQueueResult> {
  return chatQueueRequest(
    "POST",
    chatQueuePath(chatId, `/${encodeURIComponent(itemId)}/steer`),
  );
}

export function retryChatQueueItem(
  chatId: string,
  itemId: string,
): Promise<ChatQueueResult> {
  return chatQueueRequest(
    "POST",
    chatQueuePath(chatId, `/${encodeURIComponent(itemId)}/retry`),
  );
}

class ApiError extends Error {
  status: number;
  /** The server's machine-readable reason, when it gives one. */
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * The workspace has no Git repository or no commits yet: creating an Issue
 * needs the person to confirm setting up Git first (`initializeGit`).
 */
export function workspaceNeedsGit(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.code === "workspace_needs_git"
  );
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
  "issue_created",
  "issue_updated",
  "issue_run_event",
  "agent_session_created",
  "agent_session_started",
  "agent_session_event",
  "agent_subagent_updated",
  "agent_session_blocked",
  "agent_session_resumed",
  "agent_session_completed",
  "agent_session_native_session_id",
  "feishu_bot_updated",
  "workspace_members_updated",
  "chat_queue_changed",
  "chat_titles_changed",
  "chat_layout_changed",
  "foundry_data_changed",
  "chats_changed",
]);

export interface FoundryStreamResync {
  /**
   * The first connection this subscriber sees open: state it loaded while
   * that connection was opening may predate it. False: events stopped
   * arriving after they had arrived.
   */
  initial: boolean;
}

export interface FoundryStreamLifecycle {
  /** The stream stopped delivering events; it reconnects by itself. */
  onError?: () => void;
  /**
   * The stream delivers events (again). Told at once when joining an open
   * stream. A reconnect resumes where the last connection stopped (the
   * server replays what was missed), so this is no reason to reload.
   */
  onOpen?: () => void;
  /**
   * Events may be missing: the server could not replay them (it says so
   * with a `resync` message), or a connection opened with nowhere to resume
   * from. State derived from the stream must be loaded again.
   */
  onResync?: (resync: FoundryStreamResync) => void;
}

interface FoundryStreamListener {
  onEvent: (event: FoundryStreamEvent) => void;
  lifecycle: FoundryStreamLifecycle;
  /** It was told the stream is open at least once. */
  sawOpen: boolean;
}

/** Waits between reopening a connection the browser gave up on. */
export const foundryStreamReopenDelaysMs = [
  1_000, 2_000, 5_000, 10_000, 30_000,
] as const;

/**
 * One EventSource per tab, shared by every subscriber. Every message carries
 * an `id:`; the browser resends the last one as Last-Event-ID when it
 * reconnects by itself, and a connection opened again after the browser gave
 * up passes it as `lastEventId`, so the server replays what was missed (or
 * says `resync` when it cannot).
 */
const foundryStream = {
  listeners: new Set<FoundryStreamListener>(),
  open: false,
  source: undefined as EventSource | undefined,
  closeTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  reopenTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  reopenAttempts: 0,
  /** The newest message id seen: where a new connection resumes. */
  lastEventId: "",
  /** When the connection last opened or delivered a message. */
  heardAt: 0,
  /** Rises whenever events may have been missed (see foundryStreamEpoch). */
  epoch: 0,
  /** Reads waiting for the connection to open (see foundryStreamOpened). */
  openWaiters: new Set<() => void>(),
};

/** EventSource.CLOSED: the browser will not reconnect this source itself. */
const eventSourceClosed = 2;

export function isFoundryStreamOpen(): boolean {
  return foundryStream.open;
}

/**
 * Rises each time events may have been missed: a connection opened with
 * nowhere to resume from (the first one too), or the server said resync. A
 * read that started at the current epoch, after the stream opened, misses
 * nothing: every later change arrives on the stream. One from an earlier
 * epoch may be behind and is read again (see foundryStreamOpened).
 */
export function foundryStreamEpoch(): number {
  return foundryStream.epoch;
}

/** How long a read waits for the stream to open (foundryStreamOpened). */
export const foundryStreamOpenWaitMs = 1_500;

/**
 * Resolves when a read of state the stream keeps current may start: at once
 * while the stream is open (the server registered this tab before it
 * answered the opening, so it delivers every change after a later read),
 * else when it opens. A stream not open within foundryStreamOpenWaitMs is
 * waited for no longer, so a slow stream does not keep the page empty;
 * resolves `false` then: the read starts at an epoch the opening ends, and
 * is made again on its resync.
 */
export function foundryStreamOpened(): Promise<boolean> {
  if (foundryStream.open) return Promise.resolve(true);
  return new Promise((resolve) => {
    const opened = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      foundryStream.openWaiters.delete(opened);
      resolve(false);
    }, foundryStreamOpenWaitMs);
    foundryStream.openWaiters.add(opened);
  });
}

/** How long the open connection has delivered nothing (0 when not open). */
export function foundryStreamQuietMs(now = Date.now()): number {
  return foundryStream.open ? Math.max(0, now - foundryStream.heardAt) : 0;
}

/**
 * Opens the connection again, resuming after the last message: for one that
 * may have died without an error (a sleeping laptop, a stuck proxy). The
 * server's keepalives are comments a page cannot observe.
 */
export function reconnectFoundryStream(): void {
  if (foundryStream.listeners.size === 0) return;
  if (foundryStream.reopenTimer !== undefined)
    clearTimeout(foundryStream.reopenTimer);
  foundryStream.reopenTimer = undefined;
  foundryStream.source?.close();
  foundryStream.source = undefined;
  foundryStream.open = false;
  openFoundryStream();
}

function notifyFoundryStream(
  notify: (listener: FoundryStreamListener) => void,
): void {
  for (const listener of [...foundryStream.listeners]) {
    if (foundryStream.listeners.has(listener)) notify(listener);
  }
}

function rememberStreamId(message: MessageEvent): void {
  foundryStream.heardAt = Date.now();
  if (message.lastEventId) foundryStream.lastEventId = message.lastEventId;
}

function openFoundryStream(): void {
  if (foundryStream.source || foundryStream.reopenTimer !== undefined) return;
  const resumeFrom = foundryStream.lastEventId;
  const source = new EventSource(
    resumeFrom
      ? `${API_BASE_URL}/api/events?lastEventId=${encodeURIComponent(resumeFrom)}`
      : `${API_BASE_URL}/api/events`,
    { withCredentials: true },
  );
  foundryStream.source = source;
  source.onopen = () => {
    if (foundryStream.source !== source) return;
    foundryStream.open = true;
    foundryStream.reopenAttempts = 0;
    foundryStream.heardAt = Date.now();
    // The browser's own reconnects send the newest id this source saw; a
    // source that saw none sends what it was opened with. Either way it
    // resumes from lastEventId, and only without one can events be lost.
    const fresh = foundryStream.lastEventId === "";
    if (fresh) foundryStream.epoch += 1;
    notifyFoundryStream((listener) => {
      const initial = !listener.sawOpen;
      listener.sawOpen = true;
      listener.lifecycle.onOpen?.();
      if (fresh) listener.lifecycle.onResync?.({ initial });
    });
    const waiters = [...foundryStream.openWaiters];
    foundryStream.openWaiters.clear();
    waiters.forEach((opened) => opened());
  };
  source.onerror = () => {
    if (foundryStream.source !== source) return;
    foundryStream.open = false;
    notifyFoundryStream((listener) => listener.lifecycle.onError?.());
    // A connection answered with an error status (a proxy's 502 while the
    // server restarts) is closed for good: open a new one, resuming.
    if (source.readyState !== eventSourceClosed) return;
    source.close();
    foundryStream.source = undefined;
    if (foundryStream.listeners.size === 0) return;
    const delays = foundryStreamReopenDelaysMs;
    const delay =
      delays[Math.min(foundryStream.reopenAttempts, delays.length - 1)]!;
    foundryStream.reopenAttempts += 1;
    foundryStream.reopenTimer = setTimeout(() => {
      foundryStream.reopenTimer = undefined;
      if (foundryStream.listeners.size > 0) openFoundryStream();
    }, delay);
  };
  const resync = (message: MessageEvent) => {
    if (foundryStream.source !== source) return;
    rememberStreamId(message);
    foundryStream.epoch += 1;
    notifyFoundryStream((listener) =>
      listener.lifecycle.onResync?.({ initial: false }),
    );
  };
  source.addEventListener("resync", resync as EventListener);
  source.onmessage = (message) => {
    if (foundryStream.source !== source) return;
    rememberStreamId(message);
    let event: FoundryStreamEvent | undefined;
    try {
      const envelope = parseProtocolEnvelopeJSON(message.data);
      if (envelope.type === "resync") {
        resync(message);
        return;
      }
      event = envelope as FoundryStreamEvent;
    } catch {
      // A later persisted snapshot repairs malformed or interrupted stream data.
      return;
    }
    if (!event?.payload || !foundryStreamEventTypes.has(event.type)) return;
    for (const listener of [...foundryStream.listeners]) {
      listener.onEvent(event);
    }
  };
}

function closeFoundryStream(): void {
  if (foundryStream.reopenTimer !== undefined)
    clearTimeout(foundryStream.reopenTimer);
  foundryStream.reopenTimer = undefined;
  foundryStream.reopenAttempts = 0;
  foundryStream.source?.close();
  foundryStream.source = undefined;
  foundryStream.open = false;
  // Whoever subscribes next loads its own state; nothing to resume.
  foundryStream.lastEventId = "";
}

export function subscribeFoundryEvents(
  onEvent: (event: FoundryStreamEvent) => void,
  lifecycle: FoundryStreamLifecycle = {},
): () => void {
  const listener: FoundryStreamListener = {
    onEvent,
    lifecycle,
    sawOpen: foundryStream.open,
  };
  foundryStream.listeners.add(listener);
  if (foundryStream.closeTimer !== undefined) {
    clearTimeout(foundryStream.closeTimer);
    foundryStream.closeTimer = undefined;
  }
  if (foundryStream.open && lifecycle.onOpen) {
    // Joined an open stream: the subscriber loads its own state after this,
    // so it only needs to know the stream is up.
    const onOpen = lifecycle.onOpen;
    queueMicrotask(() => {
      if (foundryStream.listeners.has(listener)) onOpen();
    });
  }
  openFoundryStream();
  return () => {
    foundryStream.listeners.delete(listener);
    if (foundryStream.listeners.size > 0) return;
    // A remount re-subscribes at once; keep the connection for it.
    foundryStream.closeTimer = setTimeout(() => {
      foundryStream.closeTimer = undefined;
      if (foundryStream.listeners.size === 0) closeFoundryStream();
    }, 1000);
  };
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

/**
 * How long a read the app repeats in the background (workspace data, chat
 * titles, chat layout) may take: one that stalls fails then, so the reads
 * queued behind it go on.
 */
export const backgroundReadTimeoutMs = 30_000;

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
      await responseErrorCode(response),
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

async function responseErrorCode(
  response: Response,
): Promise<string | undefined> {
  try {
    const payload = (await response.clone().json()) as { code?: unknown };
    return typeof payload.code === "string" ? payload.code : undefined;
  } catch {
    return undefined;
  }
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

/**
 * Reads workspace data: without `fields`, every field but the pages' own
 * (the skill library's catalog); with them, those fields and the workspace.
 * Each selection keeps its own ETag, so an unchanged read costs a 304.
 */
export async function loadFoundryData(
  activeWorkspaceId?: string,
  options: RequestOptions & { fields?: readonly FoundryDataField[] } = {},
): Promise<FoundryDataLoadResult> {
  const params = new URLSearchParams();
  if (activeWorkspaceId) params.set("workspaceId", activeWorkspaceId);
  const fields = options.fields ? [...new Set(options.fields)].sort() : [];
  if (fields.length) params.set("fields", fields.join(","));
  const query = params.toString() ? `?${params.toString()}` : "";
  const selection = fields.length ? fields : undefined;
  try {
    return await getFoundryData(
      `/api/foundry-data${query}`,
      options,
      selection,
    );
  } catch (error) {
    // The workspace is gone: read whatever workspace there is now, whole.
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
  /** A selection's answer holds only its fields (and the workspace). */
  data: FoundryData;
  notModified: boolean;
  /** The fields read; undefined: every field but the pages' own. */
  fields?: readonly FoundryDataField[];
  /** When the read was asked for (Date.now()): its answer is older. */
  requestedAt: number;
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
  fields?: readonly FoundryDataField[],
): Promise<FoundryDataLoadResult> {
  const cached = foundryDataCache.get(path);
  const headers = jsonHeaders(false);
  if (cached?.etag) {
    headers["If-None-Match"] = cached.etag;
  }
  const requestedAt = Date.now();
  const response = await apiFetch(`${API_BASE_URL}${path}`, {
    headers,
    signal: options.signal,
  });
  if (response.status === 304 && cached) {
    return { data: cached.data, notModified: true, fields, requestedAt };
  }
  if (!response.ok) {
    throw new ApiError(
      await responseErrorMessage(response, path),
      response.status,
    );
  }
  const data = (await response.json()) as FoundryData;
  // Every field but the workspace is a list: one answered null (an empty
  // list, from some servers) is one.
  for (const [field, value] of Object.entries(data))
    if (value === null)
      (data as unknown as Record<string, unknown>)[field] = [];
  if (data.issues)
    data.issues = data.issues.map((issue) => ({
      ...issue,
      status: issueDisplayStatus(issue),
    }));
  if (!fields) {
    // Older servers omit the skill-isolation collections; default to empty
    // so the new UI treats them as "nothing configured" rather than
    // undefined.
    data.issues ??= [];
    data.deviceSkillRoots ??= [];
    data.workspaceSkillBindings ??= [];
  }
  const etag = response.headers.get("ETag") ?? "";
  if (etag) {
    foundryDataCache.set(path, { data, etag });
  }
  return { data, notModified: false, fields, requestedAt };
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

export interface AgentSubagentsResult {
  /** Undefined when the server answered 304: the list known is current. */
  subagents?: AgentSubagentSummary[];
  etag?: string;
}

/**
 * A session's subagents. With the ETag of the list already shown, a server
 * that supports it answers 304 and nothing is transferred again.
 */
export async function listAgentSubagents(
  sessionId: string,
  options: RequestOptions & { etag?: string } = {},
): Promise<AgentSubagentsResult> {
  const path = `/api/agent-sessions/${encodeURIComponent(sessionId)}/subagents`;
  const response = await apiFetch(`${API_BASE_URL}${path}`, {
    headers: options.etag ? { "If-None-Match": options.etag } : {},
    signal: options.signal,
  });
  const etag = response.headers.get("ETag") ?? undefined;
  if (response.status === 304) return { etag: etag ?? options.etag };
  if (!response.ok) {
    throw new ApiError(
      await responseErrorMessage(response, path),
      response.status,
    );
  }
  return {
    etag,
    subagents: (await response.json()) as AgentSubagentSummary[],
  };
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

/**
 * A session as a windowed transcript load returns it: `eventsBefore` is the
 * cursor of the events older than those included, absent once the session's
 * history is complete (and always from a server that sends all events).
 * `stateEvents`, with the newest window only, are those of the older events
 * the side panel reads (snapshots, recorded files, subagents), cut to what
 * it reads; a page of older events, or an older server, sends none.
 */
export type WindowedAgentSession = AgentSession & {
  eventsBefore?: string;
  stateEvents?: NonNullable<AgentSession["events"]>;
};

export interface TranscriptLoadProgress {
  loadedBytes: number;
  /** The transfer size when the server states it and it is not compressed. */
  totalBytes?: number;
}

export interface TranscriptRequestOptions extends RequestOptions {
  /** Only the most recent events of each session (older ones by page). */
  eventsLimit?: number;
  onProgress?: (progress: TranscriptLoadProgress) => void;
}

async function readJSONWithProgress<T>(
  response: Response,
  onProgress?: (progress: TranscriptLoadProgress) => void,
): Promise<T> {
  if (!onProgress || !response.body) return (await response.json()) as T;
  const declared = Number(response.headers.get("Content-Length"));
  const encoded = Boolean(response.headers.get("Content-Encoding"));
  const totalBytes =
    Number.isFinite(declared) && declared > 0 && !encoded
      ? declared
      : undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let loadedBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    loadedBytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
    onProgress({ loadedBytes, totalBytes });
  }
  text += decoder.decode();
  return JSON.parse(text) as T;
}

export async function getAgentSessionThread(
  threadId: string,
  workspaceId: string,
  options: TranscriptRequestOptions = {},
): Promise<WindowedAgentSession[]> {
  const params = new URLSearchParams({ workspaceId });
  if (options.eventsLimit)
    params.set("eventsLimit", String(options.eventsLimit));
  const path = `/api/agent-session-threads/${encodeURIComponent(threadId)}?${params.toString()}`;
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
  return readJSONWithProgress<WindowedAgentSession[]>(
    response,
    options.onProgress,
  );
}

/** A page of a session's events older than `before` (a cursor from a load). */
export function getAgentSessionEventsBefore(
  sessionId: string,
  before: string,
  options: RequestOptions & { eventsLimit?: number } = {},
): Promise<WindowedAgentSession> {
  const params = new URLSearchParams({ eventsBefore: before });
  if (options.eventsLimit)
    params.set("eventsLimit", String(options.eventsLimit));
  return getJSON<WindowedAgentSession>(
    `/api/agent-sessions/${encodeURIComponent(sessionId)}?${params.toString()}`,
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

/**
 * Model catalogs this page read or is reading, by request body. A catalog
 * does not change while the page is open; failures are not kept.
 */
const agentModelCatalogs = new Map<string, Promise<AgentModelOption[]>>();

/**
 * Asks the profile's device for its model catalog. With `reuse`, a catalog
 * this page read (or is reading) for the same request answers instead; an
 * explicit refresh leaves it out, asks again, and keeps the new answer. A
 * request carrying a typed API key is never kept: the key stays in its form.
 */
export function listAgentModels(
  profile: CreateAgentProfileInput,
  { reuse = false }: { reuse?: boolean } = {},
): Promise<AgentModelOption[]> {
  const body = { profile };
  if (profile.apiKey)
    return postJSON<AgentModelOption[]>("/api/agent-profiles/models", body);
  const key = JSON.stringify(body);
  const known = agentModelCatalogs.get(key);
  if (reuse && known) return known;
  const read = postJSON<AgentModelOption[]>("/api/agent-profiles/models", body);
  agentModelCatalogs.set(key, read);
  read.catch(() => {
    if (agentModelCatalogs.get(key) === read) agentModelCatalogs.delete(key);
  });
  return read;
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
