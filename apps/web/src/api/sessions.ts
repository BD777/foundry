import type {
  AgentBackgroundTaskOutput,
  AgentSession,
  AgentSubagentDigest,
  AgentSubagentTranscript,
  SessionFileDiff,
  SessionFileRead,
  SessionLink,
  SessionToolFrameList,
} from "@bd777/foundry-protocol";
import type {
  CreateAgentSessionInput,
  SendAgentSessionMessageInput,
} from "../api-types";
import { apiBaseUrl } from "../lib/api-base-url";
import {
  apiErrorOf,
  apiFetch,
  request,
  send,
  type RequestOptions,
} from "./http";

const sessionPath = (sessionId: string) =>
  `/api/agent-sessions/${encodeURIComponent(sessionId)}`;

export function createAgentSession(
  input: CreateAgentSessionInput,
  idempotencyKey?: string,
): Promise<AgentSession> {
  return request("POST", "/api/agent-sessions", {
    body: input,
    idempotencyKey,
  });
}

export function getAgentSession(
  sessionId: string,
  options: RequestOptions = {},
): Promise<AgentSession> {
  return request("GET", sessionPath(sessionId), options);
}

/** Names a session for a link to it; 403/404 when the caller may not view it. */
export function getSessionLink(
  sessionId: string,
  options: RequestOptions = {},
): Promise<SessionLink> {
  return request("GET", `${sessionPath(sessionId)}/link`, options);
}

/** The sessions that worked for one Issue, oldest first as the server lists them. */
export function listIssueSessions(
  workspaceId: string,
  issueId: string,
): Promise<AgentSession[]> {
  const params = new URLSearchParams({ workspaceId, issueId });
  return request("GET", `/api/agent-sessions?${params.toString()}`);
}

export function sendAgentSessionMessage(
  sessionId: string,
  input: SendAgentSessionMessageInput,
  idempotencyKey?: string,
): Promise<AgentSession> {
  return request("POST", `${sessionPath(sessionId)}/messages`, {
    body: input,
    idempotencyKey,
  });
}

export function cancelAgentSession(sessionId: string): Promise<AgentSession> {
  return request("POST", `${sessionPath(sessionId)}/cancel`);
}

/**
 * A session as a windowed transcript load returns it: `eventsBefore` is the
 * cursor of the events older than those included, absent once the session's
 * history is complete. `stateEvents`, with the newest window only, are those
 * of the older events the side panel reads (snapshots, recorded files,
 * subagents), cut to what it reads; a page of older events sends none.
 */
export type WindowedAgentSession = AgentSession & {
  eventsBefore?: string;
  /**
   * The newest window's newest event: where a reader holding it catches up
   * (getAgentSessionEventsAfter). Absent for an empty window and an older
   * page.
   */
  eventsAfter?: string;
  stateEvents?: NonNullable<AgentSession["events"]>;
};

/**
 * A session with the events stored after a cursor, oldest first, and where
 * to catch up next. `eventsMore`: more than the limit followed, none are
 * returned, and the reader reads the newest window instead.
 */
export type CaughtUpAgentSession = WindowedAgentSession & {
  eventsMore?: boolean;
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
  const response = await send(
    "GET",
    `/api/agent-session-threads/${encodeURIComponent(threadId)}?${params.toString()}`,
    { signal: options.signal },
  );
  return readJSONWithProgress<WindowedAgentSession[]>(
    response,
    options.onProgress,
  );
}

/**
 * A session's events after `after` (a window's or a catch-up's
 * `eventsAfter`): what a reader that missed stream events lacks. More than
 * `eventsLimit` of them answer `eventsMore` instead; a cursor the server no
 * longer knows fails (410).
 */
export function getAgentSessionEventsAfter(
  sessionId: string,
  after: string,
  options: RequestOptions & { eventsLimit?: number } = {},
): Promise<CaughtUpAgentSession> {
  const params = new URLSearchParams({ eventsAfter: after });
  if (options.eventsLimit)
    params.set("eventsLimit", String(options.eventsLimit));
  return request("GET", `${sessionPath(sessionId)}?${params.toString()}`, {
    signal: options.signal,
  });
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
  return request("GET", `${sessionPath(sessionId)}?${params.toString()}`, {
    signal: options.signal,
  });
}

/** One of a session's recorded files, read from its device. */
export function readSessionFile(
  sessionId: string,
  path: string,
  options: RequestOptions = {},
): Promise<SessionFileRead> {
  const params = new URLSearchParams({ path });
  return request(
    "GET",
    `${sessionPath(sessionId)}/files/read?${params.toString()}`,
    options,
  );
}

/** The screenshots the session's tools produced, oldest first (DEV-075). */
export function listSessionFrames(
  sessionId: string,
  options: RequestOptions = {},
): Promise<SessionToolFrameList> {
  return request("GET", `${sessionPath(sessionId)}/frames`, options);
}

/**
 * One frame's image; LocalImage adds `&variant=` for its derivatives. The
 * empty `v` keeps the URL's query open for them.
 */
export function sessionFrameImageUrl(
  sessionId: string,
  frameId: string,
): string {
  return `${apiBaseUrl}${sessionPath(sessionId)}/frames/${encodeURIComponent(frameId)}/image?v=1`;
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
  return request(
    "GET",
    `${sessionPath(sessionId)}/files/diff?${params.toString()}`,
    options,
  );
}

/**
 * The end of a background task's output and its command (members); with
 * `after` (an earlier read's lineEnd) what it gained since when the device
 * can tell. `follow` asks to be told while a running task's log grows.
 */
export function readBackgroundTaskOutput(
  sessionId: string,
  taskId: string,
  options: RequestOptions & { after?: number; follow?: boolean } = {},
): Promise<AgentBackgroundTaskOutput> {
  const params = new URLSearchParams();
  if (options.after !== undefined) params.set("after", String(options.after));
  if (options.follow) params.set("follow", "1");
  const query = params.toString();
  return request(
    "GET",
    `${sessionPath(sessionId)}/background-tasks/${encodeURIComponent(taskId)}/output${query ? `?${query}` : ""}`,
    { signal: options.signal },
  );
}

/** Asks the session's agent to stop one of its background tasks. */
export function stopBackgroundTask(
  sessionId: string,
  taskId: string,
): Promise<{ sessionId: string; taskId: string; stopping: boolean }> {
  return request(
    "POST",
    `${sessionPath(sessionId)}/background-tasks/${encodeURIComponent(taskId)}/stop`,
  );
}

export function readAgentSubagentTranscript(
  sessionId: string,
  taskId: string,
  options: RequestOptions = {},
): Promise<AgentSubagentTranscript> {
  return request(
    "GET",
    `${sessionPath(sessionId)}/subagents/${encodeURIComponent(taskId)}`,
    options,
  );
}

export interface AgentSubagentsResult {
  /** Undefined when the server answered 304: the list known is current. */
  subagents?: AgentSubagentDigest[];
  etag?: string;
}

/**
 * A session's subagents as a chat lists them: answers only as fingerprints,
 * no prompts (a subagent's own transcript is read when it is opened). With
 * the ETag of the list already shown, a server that supports it answers 304
 * and nothing is transferred again.
 */
export async function listAgentSubagents(
  sessionId: string,
  options: RequestOptions & { etag?: string } = {},
): Promise<AgentSubagentsResult> {
  const path = `${sessionPath(sessionId)}/subagents?view=digest`;
  const response = await apiFetch(`${apiBaseUrl}${path}`, {
    headers: options.etag ? { "If-None-Match": options.etag } : {},
    signal: options.signal,
  });
  const etag = response.headers.get("ETag") ?? undefined;
  if (response.status === 304) return { etag: etag ?? options.etag };
  if (!response.ok)
    throw apiErrorOf(await response.text(), path, response.status);
  return {
    etag,
    subagents: (await response.json()) as AgentSubagentDigest[],
  };
}
