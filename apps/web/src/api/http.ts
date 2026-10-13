import { apiBaseUrl } from "../lib/api-base-url";
import { foundryStream } from "../stream/foundry-stream";
import { createSharedReads, type SharedAnswer } from "../stream/shared-reads";

export class ApiError extends Error {
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

/** The server has nothing by that id for the caller: none, or not theirs. */
export function isNotFoundForCaller(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 404 || error.status === 403)
  );
}

const authRequiredListeners = new Set<() => void>();

/**
 * Subscribes to HTTP 401 answers, i.e. the login session is missing or gone,
 * and to signing out in another tab, which ends it here too.
 */
export function onAuthRequired(listener: () => void): () => void {
  authRequiredListeners.add(listener);
  const stopTabs = foundryStream.onSignedOutElsewhere(listener);
  return () => {
    authRequiredListeners.delete(listener);
    stopTabs();
  };
}

export function notifyAuthRequired(): void {
  authRequiredListeners.forEach((listener) => listener());
}

/**
 * Every browser API request goes through here so the HttpOnly login cookie is
 * sent, including to a separate API origin during development.
 */
export async function apiFetch(
  input: string,
  init: RequestInit = {},
  { notifyAuthRequired: notify = true } = {},
): Promise<Response> {
  const writes = (init.method ?? "GET").toUpperCase() !== "GET";
  try {
    const response = await fetch(input, { ...init, credentials: "include" });
    if (response.status === 401 && notify) notifyAuthRequired();
    return response;
  } finally {
    // What it changed is not in answers that started before it ended.
    if (writes) sharedReads.wrote();
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface RequestInput extends RequestOptions {
  /** Sent as JSON; a file, blob or form is sent as it is. */
  body?: unknown;
  /** Makes a repeated request (a reload, another tab) take effect once. */
  idempotencyKey?: string;
  /** False where a 401 is not a lost session, such as a wrong password. */
  notifyAuthRequired?: boolean;
}

/** Authentication rides on the session cookie that apiFetch always sends. */
export function requestInit(
  method: string,
  { body, idempotencyKey, signal }: RequestInput,
): RequestInit {
  const raw = body instanceof Blob || body instanceof FormData;
  const headers: Record<string, string> = {};
  if (body !== undefined && !raw) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  return {
    method,
    headers,
    signal,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  };
}

/** Sends a request; an error status fails with the server's message (ApiError). */
export async function send(
  method: string,
  path: string,
  input: RequestInput = {},
): Promise<Response> {
  const response = await apiFetch(
    `${apiBaseUrl}${path}`,
    requestInit(method, input),
    { notifyAuthRequired: input.notifyAuthRequired },
  );
  if (!response.ok)
    throw apiErrorOf(
      await response.text().catch(() => ""),
      path,
      response.status,
    );
  return response;
}

/** Sends a request and reads its JSON answer; 204 resolves to undefined. */
export async function request<T>(
  method: string,
  path: string,
  input: RequestInput = {},
): Promise<T> {
  const response = await send(method, path, input);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * The error an answer with an error status stands for: the server's message
 * and reason when it gives them, else its text, else the status.
 */
export function apiErrorOf(
  body: string,
  path: string,
  status: number,
): ApiError {
  let payload: { error?: unknown; code?: unknown } | undefined;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = undefined;
  }
  const detail = body.trim();
  const message =
    typeof payload?.error === "string" && payload.error
      ? payload.error
      : detail && !detail.startsWith("<")
        ? detail.slice(0, 2000)
        : `${path} returned ${status}`;
  return new ApiError(
    // A worker's error relayed as it printed it.
    message.replace(/^Error: /, ""),
    status,
    typeof payload?.code === "string" ? payload.code : undefined,
  );
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

/**
 * Reads the tabs of this browser share (see stream/shared-reads.ts): each
 * read answers every tab that needs it at the time.
 */
export const sharedReads = createSharedReads({
  stream: foundryStream,
  timeoutMs: backgroundReadTimeoutMs,
  fetch: async (path, etag, signal) => {
    const response = await apiFetch(
      `${apiBaseUrl}${path}`,
      { headers: etag ? { "If-None-Match": etag } : {}, signal },
      // The tab that asked hears of a 401 (sharedGet).
      { notifyAuthRequired: false },
    );
    return {
      status: response.status,
      etag: response.headers.get("ETag") ?? "",
      body: response.status === 304 ? "" : await response.text(),
    };
  },
});

/** A shared read (sharedReads), failing like request on an error status. */
export async function sharedGet(
  path: string,
  options: RequestOptions = {},
): Promise<SharedAnswer> {
  const answer = await sharedReads.read(path, options.signal);
  if (answer.status === 401) notifyAuthRequired();
  if (answer.status < 200 || answer.status >= 300)
    throw apiErrorOf(answer.body, path, answer.status);
  return answer;
}

export async function sharedGetJSON<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  return JSON.parse((await sharedGet(path, options)).body) as T;
}
