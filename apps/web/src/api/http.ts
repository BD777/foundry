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

/**
 * The server's database stayed locked for a moment (another process held
 * it): 503 database_busy, which the same request survives once retried.
 */
export function isDatabaseBusy(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 503 &&
    error.code === "database_busy"
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
    const response = writes
      ? await fetch(input, { ...init, credentials: "include" })
      : await fetchThroughRestart(input, { ...init, credentials: "include" });
    if (response.status === 401 && notify) notifyAuthRequired();
    return response;
  } finally {
    // What it changed is not in answers that started before it ended.
    if (writes) sharedReads.wrote();
  }
}

/**
 * Waits between attempts of a read the server could not answer because it
 * was restarting: about five seconds in all, longer than a restart takes.
 */
export const restartRetryDelaysMs = [250, 500, 1000, 1500, 2000];

/**
 * The header the server sets on the 503 it answers while it is still
 * starting (its readiness gate).
 */
export const serverStartingHeader = "X-Foundry-Starting";

/**
 * Whether an answer says the server itself was not there to answer: the
 * proxy's own error page (502/504 as HTML, while the server's port was
 * closed during a restart), or the starting server's 503. The API's own
 * 502–504 answers (a device that timed out, a lost response) and every other
 * 503 (database busy, device busy) are its answer to this request, which the
 * caller handles, so they are not retried here.
 */
function answeredByRestart(response: Response): boolean {
  if (response.status === 503)
    return response.headers.has(serverStartingHeader);
  if (response.status !== 502 && response.status !== 504) return false;
  return (response.headers.get("Content-Type") ?? "").startsWith("text/html");
}

/**
 * A read (GET) that reached no server, because the server was restarting,
 * is sent again quietly instead of failing (answeredByRestart). Anything else
 * is returned at once, including a failed connection (fetch rejects): behind
 * the proxy a restart never refuses the browser's connection, so that means
 * the browser is offline, which the caller reports. Writes are never resent
 * here: one may have taken effect.
 */
export async function fetchThroughRestart(
  input: string,
  init: RequestInit,
  delaysMs: readonly number[] = restartRetryDelaysMs,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(input, init);
    const delay = delaysMs[attempt];
    if (delay === undefined || !answeredByRestart(response)) return response;
    void response.body?.cancel().catch(() => {});
    await wait(delay);
    if (init.signal?.aborted) throw init.signal.reason;
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
  /** Extra request headers, such as the device file intent. */
  headers?: Record<string, string>;
}

/** Authentication rides on the session cookie that apiFetch always sends. */
export function requestInit(
  method: string,
  { body, headers: extra, idempotencyKey, signal }: RequestInput,
): RequestInit {
  const raw = body instanceof Blob || body instanceof FormData;
  const headers: Record<string, string> = { ...extra };
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
