// HTTP/WS transport for talking to the Foundry server. Owns the run
// transports, JSON helpers, and WebSocket envelope sending. Depends on
// config only for the pairing code header.

import WebSocket from "ws";
import {
  daemonMessageTypes,
  parseProtocolEnvelopeJSON,
  type AcceptanceArtifact,
  type ProtocolEnvelope,
  type Run,
  type RunEvent,
} from "@foundry/protocol";
import { readDaemonConfig } from "./config.js";

export type IssueCompletion = {
  canceled?: boolean;
  response?: string;
  artifact: AcceptanceArtifact;
  checks: string[];
  runId: string;
  environmentId?: string;
  environmentRevision?: number;
  executionCwd?: string;
  error?: string;
};

export interface RunTransport {
  appendRunEvent(runId: string, event: RunEvent): Promise<void>;
  completeIssue(issueId: string, input: IssueCompletion): Promise<void>;
  startRun(issueId: string, run: Run): Promise<void>;
}

export const deviceCredentialHeader = "X-Foundry-Device-Credential";

export function daemonRequestHeaders(
  includeContentType: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (includeContentType) {
    headers["Content-Type"] = "application/json";
  }
  const credential = readDaemonConfig()?.deviceCredential?.trim();
  if (credential) {
    headers[deviceCredentialHeader] = credential;
  }
  return headers;
}

export async function postJSON<T>(
  serverURL: string,
  path: string,
  body: unknown,
): Promise<T | undefined> {
  const response = await fetch(`${serverURL}${path}`, {
    method: "POST",
    headers: daemonRequestHeaders(true),
    body: JSON.stringify(body),
  });
  if (response.status === 204) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(
      `${path} returned ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

export async function getJSON<T>(serverURL: string, path: string): Promise<T> {
  const response = await fetch(`${serverURL}${path}`, {
    headers: daemonRequestHeaders(false),
  });
  if (!response.ok) {
    throw new Error(
      `${path} returned ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

export async function ensureServerReachable(serverURL: string): Promise<void> {
  const healthURL = new URL("/healthz", serverURL).toString();
  try {
    const response = await fetch(healthURL);
    if (!response.ok) {
      throw new Error(`health check returned ${response.status}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Foundry server is not reachable at ${serverURL}. Start the server first, then rerun setup. (${detail})`,
    );
  }
}

export class HttpRunTransport implements RunTransport {
  serverURL: string;

  constructor(serverURL: string) {
    this.serverURL = serverURL;
  }

  async startRun(issueId: string, run: Run): Promise<void> {
    await postJSON(this.serverURL, `/api/daemon/issues/${issueId}/runs`, {
      run,
    });
  }

  async appendRunEvent(runId: string, event: RunEvent): Promise<void> {
    await postJSON(this.serverURL, `/api/daemon/runs/${runId}/events`, {
      event,
    });
  }

  async completeIssue(issueId: string, input: IssueCompletion): Promise<void> {
    await postJSON(
      this.serverURL,
      `/api/daemon/issues/${issueId}/complete`,
      input,
    );
  }
}

export class WebSocketRunTransport implements RunTransport {
  socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;
  }

  async startRun(issueId: string, run: Run): Promise<void> {
    sendWebSocket(this.socket, daemonMessageTypes.runStarted, { issueId, run });
  }

  async appendRunEvent(_runId: string, event: RunEvent): Promise<void> {
    sendWebSocket(this.socket, daemonMessageTypes.runEvent, { event });
  }

  async completeIssue(issueId: string, input: IssueCompletion): Promise<void> {
    sendWebSocket(this.socket, daemonMessageTypes.issueCompleted, {
      issueId,
      ...input,
    });
  }
}

export class ReliableRunTransport implements RunTransport {
  constructor(private readonly transport: ReliableSessionTransport) {}
  async startRun(issueId: string, run: Run): Promise<void> {
    this.transport.send(daemonMessageTypes.runStarted, { issueId, run });
  }
  async appendRunEvent(_runId: string, event: RunEvent): Promise<void> {
    this.transport.send(daemonMessageTypes.runEvent, { event });
  }
  async completeIssue(issueId: string, input: IssueCompletion): Promise<void> {
    this.transport.send(daemonMessageTypes.issueCompleted, {
      issueId,
      ...input,
    });
  }
}

interface WebSocketSender {
  readonly readyState: number;
  send(data: string): unknown;
}

interface PendingSessionEnvelope {
  coalesceKey?: string;
  envelope: ProtocolEnvelope;
}

/**
 * Reliable, reconnectable outbox for agent-session lifecycle traffic.
 *
 * Session execution outlives an individual daemon WebSocket. Keeping this
 * transport separate from request/response RPC means a reconnect can rebind
 * the stream without making file reads, model discovery, or workspace setup
 * implicitly retryable. Envelopes stay pending until the server ACKs them;
 * cumulative response snapshots are coalesced while disconnected.
 */
export class ReliableSessionTransport {
  private readonly coalescedEnvelopeIds = new Map<string, string>();
  private readonly pending = new Map<string, PendingSessionEnvelope>();
  private readonly retryIntervalMs: number;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private sequence = 0;
  private socket?: WebSocketSender;

  constructor(retryIntervalMs = 1000) {
    this.retryIntervalMs = retryIntervalMs;
  }

  bind(socket: WebSocketSender): void {
    this.socket = socket;
    this.flush();
    this.scheduleRetry();
  }

  unbind(socket: WebSocketSender): void {
    if (this.socket === socket) {
      this.socket = undefined;
      this.clearRetry();
    }
  }

  send(type: string, payload?: unknown): string {
    const id = `session_${Date.now()}_${++this.sequence}`;
    const envelope: ProtocolEnvelope = {
      id,
      payload,
      type,
    };
    const coalesceKey = sessionEnvelopeCoalesceKey(type, payload);
    if (coalesceKey) {
      const previousId = this.coalescedEnvelopeIds.get(coalesceKey);
      if (previousId) {
        this.pending.delete(previousId);
      }
      this.coalescedEnvelopeIds.set(coalesceKey, id);
    }
    this.pending.set(id, { coalesceKey, envelope });
    this.write(envelope);
    this.scheduleRetry();
    return id;
  }

  acknowledge(id: string | undefined): void {
    if (!id) {
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    if (
      pending.coalesceKey &&
      this.coalescedEnvelopeIds.get(pending.coalesceKey) === id
    ) {
      this.coalescedEnvelopeIds.delete(pending.coalesceKey);
    }
    if (this.pending.size === 0) {
      this.clearRetry();
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private flush(): void {
    for (const { envelope } of this.pending.values()) {
      if (!this.write(envelope)) {
        return;
      }
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.socket || this.pending.size === 0) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.flush();
      this.scheduleRetry();
    }, this.retryIntervalMs);
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (!this.retryTimer) {
      return;
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private write(envelope: ProtocolEnvelope): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      socket.send(JSON.stringify(envelope));
      return true;
    } catch {
      return false;
    }
  }
}

function sessionEnvelopeCoalesceKey(
  type: string,
  payload: unknown,
): string | undefined {
  if (
    type !== daemonMessageTypes.sessionEvent ||
    !payload ||
    typeof payload !== "object"
  ) {
    return undefined;
  }
  const event = (payload as Record<string, unknown>).event;
  if (!event || typeof event !== "object") {
    return undefined;
  }
  const record = event as Record<string, unknown>;
  return record.label === "Response stream" && typeof record.id === "string"
    ? `response:${record.id}`
    : undefined;
}

export function webSocketURL(serverURL: string): string {
  const url = new URL(serverURL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/daemon/ws";
  url.search = "";
  return url.toString();
}

export function sendWebSocket(
  socket: WebSocket,
  type: string,
  payload?: unknown,
  id?: string,
): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  const envelope: ProtocolEnvelope = {
    id: id ?? `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    payload,
    type,
  };
  socket.send(JSON.stringify(envelope));
}

export function trySendWebSocket(
  socket: WebSocket,
  type: string,
  payload?: unknown,
  id?: string,
): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  try {
    sendWebSocket(socket, type, payload, id);
    return true;
  } catch {
    return false;
  }
}

// Re-export for callers that previously imported parseProtocolEnvelopeJSON
// alongside the transport helpers.
export { parseProtocolEnvelopeJSON };
