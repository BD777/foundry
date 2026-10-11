// HTTP/WS transport for talking to the Foundry server. Owns the run
// transports, JSON helpers, and WebSocket envelope sending. Depends on
// config only for the pairing code header.

import WebSocket from "ws";
import {
  daemonMessageTypes,
  parseProtocolEnvelopeJSON,
  processLabels,
  type AcceptanceArtifact,
  type ProtocolEnvelope,
  type Run,
  type RunEvent,
} from "@bd777/foundry-protocol";
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

/**
 * An Issue execution reports through its session (role issue_execution): the
 * run starts and ends with the session, run events are session events, and
 * the Issue result travels with session_completed.
 */
export class SessionRunTransport implements RunTransport {
  constructor(
    private readonly transport: ReliableSessionTransport,
    private readonly sessionId: string,
    private readonly inputId?: string,
  ) {}
  async startRun(): Promise<void> {
    this.transport.send(daemonMessageTypes.sessionStarted, {
      sessionId: this.sessionId,
      inputId: this.inputId,
    });
  }
  async appendRunEvent(_runId: string, event: RunEvent): Promise<void> {
    this.transport.send(daemonMessageTypes.sessionEvent, {
      event: {
        id: event.id,
        sessionId: this.sessionId,
        at: event.at,
        label: event.label,
        detail: event.detail,
        level: event.level,
      },
    });
  }
  async completeIssue(_issueId: string, input: IssueCompletion): Promise<void> {
    this.transport.send(
      daemonMessageTypes.sessionCompleted,
      issueSessionCompletion(this.sessionId, this.inputId, input),
    );
  }
}

/** The session_completed message that hands an Issue result to the server. */
export function issueSessionCompletion(
  sessionId: string,
  inputId: string | undefined,
  completion: IssueCompletion,
): Record<string, unknown> {
  return {
    sessionId,
    inputId,
    response: completion.response,
    error: completion.error,
    issueResult: completion,
  };
}

interface WebSocketSender {
  readonly readyState: number;
  /** Bytes the socket holds that the network has not taken yet. */
  readonly bufferedAmount?: number;
  send(data: string, callback?: (error?: Error) => void): unknown;
}

interface PendingSessionEnvelope {
  coalesceKey?: string;
  /** The envelope as written: serialized once, however often it is sent. */
  data: string;
  /** When it was handed to the outbox; how late it is when it goes. */
  queuedAt: number;
  /** Goes ahead of the queued events (see urgentSessionMessageTypes). */
  urgent: boolean;
  /** How often the server said it could not handle it. */
  failures: number;
  /** When it was last written to the bound socket. */
  writtenAt?: number;
  /** Written again on this socket because no answer came (see checkAnswers). */
  resent: boolean;
}

/** What the outbox holds, as the worker's heartbeat reports it. */
export interface SessionOutboxStats {
  /** Messages waiting to be written to the socket. */
  queued: number;
  /** Age of the oldest message still waiting to be written, in ms. */
  oldestQueuedMs: number;
  /** Messages written or waiting that the server has not acknowledged. */
  unacknowledged: number;
  /**
   * How long the latest acknowledged message took from being sent to its
   * acknowledgement, in ms; 0 without one in the last two minutes. With
   * oldestQueuedMs, how late what the worker sends reaches the server.
   */
  ackLatencyMs: number;
  /** Bytes the socket holds that the network has not taken yet. */
  bufferedBytes: number;
}

export interface ReliableSessionTransportOptions {
  /**
   * Events are written only while the socket holds less than this; RPC
   * replies written directly to the socket wait behind at most this much.
   */
  highWaterMarkBytes?: number;
  /** How often a backed-up socket is looked at again. */
  drainCheckMs?: number;
  /** First wait before a message the server refused is sent again. */
  failureRetryMs?: number;
  /** Refusals after which a message waits for the next connection. */
  maxFailureRetries?: number;
  /** How long a written message may go unanswered on a drained socket. */
  answerTimeoutMs?: number;
  /** How often unanswered messages are looked for. */
  answerCheckMs?: number;
  /**
   * An envelope sent on the bound socket whose JSON is longer than this
   * goes in pieces of this many characters, once the server takes pieces
   * (see bind).
   */
  pieceChars?: number;
  now?: () => number;
}

/** What the server said it takes, in its answer to the registration. */
export interface ServerFeatures {
  /** Large envelopes may go in pieces (reply_chunk). */
  replyChunks?: boolean;
}

/** The server's registered answer as features; an older server sends none. */
export function serverFeatures(payload: unknown): ServerFeatures {
  const features =
    payload && typeof payload === "object"
      ? (payload as { features?: unknown }).features
      : undefined;
  return {
    replyChunks: Array.isArray(features) && features.includes("reply_chunks"),
  };
}

/** A large envelope going out in pieces. */
interface PiecedEnvelope {
  id: string;
  data: string;
  /** Characters of data already sent. */
  sent: number;
  /** The next piece's number. */
  seq: number;
}

/**
 * Lifecycle messages the server acts on at once: a backlog of events must
 * never hold a session in "queued". Nothing of their session is ahead of them
 * (a session's events follow its start), so they may overtake the queue.
 */
const urgentSessionMessageTypes = new Set<string>([
  daemonMessageTypes.sessionStarted,
]);

// At 10 KB/s (a slow uplink) 64 KB is ~6 s ahead of any reply.
const defaultHighWaterMarkBytes = 64 * 1024;
const defaultDrainCheckMs = 250;
const defaultFailureRetryMs = 1000;
const maxFailureRetryMs = 60_000;
// 1 + 2 + … + 60 s: about three minutes of retries, then the next connection.
const defaultMaxFailureRetries = 8;
const defaultAnswerTimeoutMs = 5 * 60_000;
const defaultAnswerCheckMs = 60_000;
const recentAckMs = 2 * 60_000;
// At 10 KB/s 16 KB is under two seconds: what a small reply waits for at
// most beyond the high-water mark.
const defaultPieceChars = 16 * 1024;

/**
 * The outbox bound to a socket whose server takes pieces: sendWebSocket
 * hands it that socket's large envelopes.
 */
const piecingOutboxes = new WeakMap<
  WebSocketSender,
  ReliableSessionTransport
>();

/**
 * Reliable, reconnectable outbox for agent-session lifecycle traffic.
 *
 * Session execution outlives an individual daemon WebSocket. Keeping this
 * transport separate from request/response RPC means a reconnect can rebind
 * the stream without making file reads, model discovery, or workspace setup
 * implicitly retryable. Envelopes stay pending until the server ACKs them.
 *
 * A WebSocket delivers in order or the connection drops, so a message is
 * written once per socket: what the server has not acknowledged goes again
 * after a reconnect; a message the server answered with an error goes again
 * after a growing wait (a few times, then with the next connection); and one
 * written minutes ago with no answer at all, the socket long drained, goes
 * once more (an older server could drop its answer). The server takes a
 * message it already has as a no-op. (Resending everything unacknowledged
 * every second fed a slow uplink faster than it drained: byte-dev sent each
 * event ~40 times and fell hours behind.)
 *
 * Events are written only while the socket holds less than
 * highWaterMarkBytes, so the socket never holds more than a few seconds of
 * them and replies written straight to it are not stuck behind a backlog.
 * A newer version of the same event, snapshot or subagent progress replaces
 * an older one the server has not acknowledged: not yet written, it never
 * goes; written, it is not sent again after a reconnect. Lifecycle messages
 * and other events are never dropped.
 *
 * A large envelope sent on the bound socket with sendWebSocket (a skill scan,
 * a 1 MiB file chunk) would otherwise sit in the socket ahead of everything
 * after it for minutes on a slow uplink. When the server takes pieces it
 * goes as reply_chunk pieces instead, written like events while the socket
 * has room, taking turns with the events and with other large envelopes, so
 * urgent lifecycle messages and small replies are never behind more than
 * the high-water mark and one piece. Pieces belong to their socket: like
 * the request they answer, they are dropped with it.
 */
export class ReliableSessionTransport {
  private readonly coalescedEnvelopeIds = new Map<string, string>();
  /** Every message the server has not acknowledged, oldest first. */
  private readonly pending = new Map<string, PendingSessionEnvelope>();
  /** Not yet written to the bound socket, in order. */
  private readonly urgent = new Set<string>();
  private readonly queued = new Set<string>();
  private readonly failureRetries = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly settledWaiters = new Set<() => void>();
  private readonly highWaterMarkBytes: number;
  private readonly drainCheckMs: number;
  private readonly failureRetryMs: number;
  private readonly maxFailureRetries: number;
  private readonly answerTimeoutMs: number;
  private readonly answerCheckMs: number;
  private readonly pieceChars: number;
  private readonly now: () => number;
  /** Large envelopes going out in pieces, the next to send a piece first. */
  private readonly pieced: PiecedEnvelope[] = [];
  private answerTimer?: ReturnType<typeof setTimeout>;
  private drainTimer?: ReturnType<typeof setTimeout>;
  private lastAck?: { at: number; latencyMs: number };
  /** Whether a piece goes before the next queued event. */
  private pieceTurn = false;
  private pumpScheduled = false;
  private sequence = 0;
  private socket?: WebSocketSender;

  constructor(options: ReliableSessionTransportOptions = {}) {
    this.highWaterMarkBytes =
      options.highWaterMarkBytes ?? defaultHighWaterMarkBytes;
    this.drainCheckMs = options.drainCheckMs ?? defaultDrainCheckMs;
    this.failureRetryMs = options.failureRetryMs ?? defaultFailureRetryMs;
    this.maxFailureRetries =
      options.maxFailureRetries ?? defaultMaxFailureRetries;
    this.answerTimeoutMs = options.answerTimeoutMs ?? defaultAnswerTimeoutMs;
    this.answerCheckMs = options.answerCheckMs ?? defaultAnswerCheckMs;
    this.pieceChars = options.pieceChars ?? defaultPieceChars;
    this.now = options.now ?? Date.now;
  }

  /**
   * Carries the outbox on socket from now on. features is what the server
   * said it takes; large envelopes go in pieces only to a server that takes
   * them.
   */
  bind(socket: WebSocketSender, features: ServerFeatures = {}): void {
    if (features.replyChunks) piecingOutboxes.set(socket, this);
    else piecingOutboxes.delete(socket);
    if (this.socket === socket) {
      // Registered again on the same connection: it already has what was
      // written to it.
      this.pump();
      return;
    }
    if (this.socket) piecingOutboxes.delete(this.socket);
    this.socket = socket;
    // What was going out in pieces answered the old connection's requests.
    this.pieced.length = 0;
    // A new connection carries everything unacknowledged again, in order.
    this.clearFailureRetries();
    this.urgent.clear();
    this.queued.clear();
    for (const [id, entry] of this.pending) {
      entry.failures = 0;
      entry.writtenAt = undefined;
      entry.resent = false;
      (entry.urgent ? this.urgent : this.queued).add(id);
    }
    this.pump();
  }

  unbind(socket: WebSocketSender): void {
    if (this.socket === socket) {
      piecingOutboxes.delete(socket);
      this.pieced.length = 0;
      this.socket = undefined;
      this.clearDrainCheck();
      this.clearAnswerCheck();
      this.settle();
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
        this.forget(previousId);
      }
      this.coalescedEnvelopeIds.set(coalesceKey, id);
    }
    const entry: PendingSessionEnvelope = {
      coalesceKey,
      data: JSON.stringify(envelope),
      failures: 0,
      queuedAt: this.now(),
      resent: false,
      urgent: urgentSessionMessageTypes.has(type),
    };
    this.pending.set(id, entry);
    (entry.urgent ? this.urgent : this.queued).add(id);
    this.pump();
    return id;
  }

  acknowledge(id: string | undefined): void {
    const entry = id ? this.pending.get(id) : undefined;
    if (!id || !entry) {
      return;
    }
    const at = this.now();
    this.lastAck = { at, latencyMs: Math.max(0, at - entry.queuedAt) };
    this.forget(id);
    if (this.pending.size === 0) {
      this.settle();
    }
  }

  /**
   * The server answered a message with an error (it could not store it):
   * it goes again after a wait that doubles with each refusal, up to
   * maxFailureRetries times; then it waits for the next connection. Reports
   * whether the id was one of this outbox's messages.
   */
  retryAfterError(id: string | undefined): boolean {
    const entry = id ? this.pending.get(id) : undefined;
    if (!id || !entry) {
      return false;
    }
    if (
      this.urgent.has(id) ||
      this.queued.has(id) ||
      this.failureRetries.has(id) ||
      entry.failures >= this.maxFailureRetries
    ) {
      return true;
    }
    entry.failures += 1;
    const delay = Math.min(
      this.failureRetryMs * 2 ** (entry.failures - 1),
      maxFailureRetryMs,
    );
    const timer = setTimeout(() => {
      this.failureRetries.delete(id);
      if (!this.pending.has(id) || !this.socket) {
        return;
      }
      (entry.urgent ? this.urgent : this.queued).add(id);
      this.pump();
    }, delay);
    timer.unref?.();
    this.failureRetries.set(id, timer);
    return true;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Sends one serialized envelope on the bound socket in pieces, taking
   * turns with events and other large envelopes. False when it is small,
   * socket is not the bound one or its server does not take pieces: send it
   * whole.
   */
  sendInPieces(socket: WebSocketSender, id: string, data: string): boolean {
    if (
      data.length <= this.pieceChars ||
      socket !== this.socket ||
      piecingOutboxes.get(socket) !== this
    )
      return false;
    this.pieced.push({ id, data, sent: 0, seq: 0 });
    this.pump();
    return true;
  }

  /**
   * Resolves true once the server acknowledged everything sent, false when
   * timeoutMs passes first or no socket is left to carry it.
   */
  whenSettled(timeoutMs: number): Promise<boolean> {
    if (this.pending.size === 0) {
      return Promise.resolve(true);
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.settledWaiters.delete(done);
        resolve(this.pending.size === 0);
      };
      const timer = setTimeout(done, timeoutMs);
      this.settledWaiters.add(done);
    });
  }

  outboxStats(): SessionOutboxStats {
    const now = this.now();
    let oldestQueued: number | undefined;
    for (const id of [...this.urgent, ...this.queued]) {
      const queuedAt = this.pending.get(id)?.queuedAt;
      if (
        queuedAt !== undefined &&
        (oldestQueued === undefined || queuedAt < oldestQueued)
      ) {
        oldestQueued = queuedAt;
      }
    }
    const lastAck = this.lastAck;
    return {
      queued: this.urgent.size + this.queued.size,
      oldestQueuedMs:
        oldestQueued === undefined ? 0 : Math.max(0, now - oldestQueued),
      unacknowledged: this.pending.size,
      ackLatencyMs:
        lastAck && now - lastAck.at <= recentAckMs ? lastAck.latencyMs : 0,
      bufferedBytes: this.socket?.bufferedAmount ?? 0,
    };
  }

  private forget(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) {
      return;
    }
    this.pending.delete(id);
    this.urgent.delete(id);
    this.queued.delete(id);
    const retry = this.failureRetries.get(id);
    if (retry) {
      clearTimeout(retry);
      this.failureRetries.delete(id);
    }
    if (
      entry.coalesceKey &&
      this.coalescedEnvelopeIds.get(entry.coalesceKey) === id
    ) {
      this.coalescedEnvelopeIds.delete(entry.coalesceKey);
    }
  }

  private settle(): void {
    for (const done of [...this.settledWaiters]) {
      done();
    }
  }

  /**
   * Writes what may go now: urgent messages, then events and pieces of
   * large envelopes, taking turns, while there is room.
   */
  private pump(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    for (const id of this.urgent) {
      if (!this.write(socket, id)) {
        return;
      }
      this.urgent.delete(id);
    }
    while (this.queued.size > 0 || this.pieced.length > 0) {
      if ((socket.bufferedAmount ?? 0) >= this.highWaterMarkBytes) {
        this.scheduleDrainCheck();
        return;
      }
      if (
        this.pieced.length > 0 &&
        (this.pieceTurn || this.queued.size === 0)
      ) {
        if (!this.writePiece(socket)) {
          return;
        }
        this.pieceTurn = false;
        continue;
      }
      const id = this.queued.values().next().value as string;
      if (!this.write(socket, id)) {
        return;
      }
      this.queued.delete(id);
      this.pieceTurn = true;
    }
    this.clearDrainCheck();
  }

  /** Writes the next piece of the first large envelope, which then waits its turn. */
  private writePiece(socket: WebSocketSender): boolean {
    const envelope = this.pieced[0]!;
    let end = Math.min(envelope.sent + this.pieceChars, envelope.data.length);
    // A piece ends between characters, never inside a surrogate pair.
    const last = envelope.data.charCodeAt(end - 1);
    if (end < envelope.data.length && last >= 0xd800 && last <= 0xdbff) {
      end -= 1;
    }
    const piece: ProtocolEnvelope = {
      type: daemonMessageTypes.replyChunk,
      payload: {
        id: envelope.id,
        seq: envelope.seq,
        ...(end === envelope.data.length ? { last: true } : {}),
        data: envelope.data.slice(envelope.sent, end),
      },
    };
    try {
      socket.send(JSON.stringify(piece), () => this.pumpSoon());
    } catch {
      return false;
    }
    this.pieced.shift();
    envelope.sent = end;
    envelope.seq += 1;
    if (envelope.sent < envelope.data.length) this.pieced.push(envelope);
    return true;
  }

  private write(socket: WebSocketSender, id: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) {
      return true;
    }
    try {
      // The socket took it once the callback runs: room for the next.
      socket.send(entry.data, () => this.pumpSoon());
      entry.writtenAt = this.now();
      this.scheduleAnswerCheck();
      return true;
    } catch {
      return false;
    }
  }

  private pumpSoon(): void {
    if (
      this.pumpScheduled ||
      (this.queued.size === 0 && this.pieced.length === 0)
    ) {
      return;
    }
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  /** Replies written straight to the socket fill it too, without a callback here. */
  private scheduleDrainCheck(): void {
    if (this.drainTimer) {
      return;
    }
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      this.pump();
    }, this.drainCheckMs);
    this.drainTimer.unref?.();
  }

  private clearDrainCheck(): void {
    if (!this.drainTimer) {
      return;
    }
    clearTimeout(this.drainTimer);
    this.drainTimer = undefined;
  }

  private scheduleAnswerCheck(): void {
    if (this.answerTimer) {
      return;
    }
    this.answerTimer = setTimeout(() => {
      this.answerTimer = undefined;
      this.checkAnswers();
    }, this.answerCheckMs);
    this.answerTimer.unref?.();
  }

  private clearAnswerCheck(): void {
    if (!this.answerTimer) {
      return;
    }
    clearTimeout(this.answerTimer);
    this.answerTimer = undefined;
  }

  /**
   * A message written answerTimeoutMs ago with neither ack nor error, while
   * everything written since left the socket, lost its answer: an older
   * server drops answers when its own queue to the device is full. It goes
   * once more on this socket.
   */
  private checkAnswers(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    let waiting = false;
    const drained =
      (socket.bufferedAmount ?? 0) === 0 &&
      this.urgent.size === 0 &&
      this.queued.size === 0 &&
      this.pieced.length === 0;
    const now = this.now();
    for (const [id, entry] of this.pending) {
      if (
        entry.writtenAt === undefined ||
        entry.resent ||
        this.failureRetries.has(id) ||
        this.urgent.has(id) ||
        this.queued.has(id)
      ) {
        continue;
      }
      if (!drained || now - entry.writtenAt < this.answerTimeoutMs) {
        waiting = true;
        continue;
      }
      entry.resent = true;
      (entry.urgent ? this.urgent : this.queued).add(id);
    }
    this.pump();
    if (waiting) {
      this.scheduleAnswerCheck();
    }
  }

  private clearFailureRetries(): void {
    for (const timer of this.failureRetries.values()) {
      clearTimeout(timer);
    }
    this.failureRetries.clear();
  }
}

/**
 * What a session event supersedes when it waits unsent: the same event
 * again (a growing response is sent under one id, and the server keeps only
 * its latest), a newer timer or background-task snapshot (only the latest
 * counts) or a subagent's next progress report. Undefined for anything that
 * must arrive as sent.
 */
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
  const sessionId =
    typeof record.sessionId === "string" ? record.sessionId : "";
  const metadata =
    record.metadata && typeof record.metadata === "object"
      ? (record.metadata as Record<string, unknown>)
      : undefined;
  if (metadata?.timerSnapshot !== undefined) {
    return `timers:${sessionId}`;
  }
  if (metadata?.backgroundTaskSnapshot !== undefined) {
    return `background:${sessionId}`;
  }
  if (
    record.label === processLabels.subtaskRunning &&
    typeof metadata?.taskId === "string" &&
    metadata.taskId
  ) {
    return `subtask:${sessionId}:${metadata.taskId}`;
  }
  return typeof record.id === "string" && record.id
    ? `event:${record.id}`
    : undefined;
}

export function webSocketURL(serverURL: string): string {
  const url = new URL(serverURL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/daemon/ws";
  url.search = "";
  return url.toString();
}

/**
 * Writes one envelope to the socket at once, unless it is large and the
 * socket's outbox sends large envelopes in pieces (see
 * ReliableSessionTransport).
 */
export function sendWebSocket(
  socket: WebSocket,
  type: string,
  payload?: unknown,
  id?: string,
): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  const envelopeId =
    id ?? `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const envelope: ProtocolEnvelope = { id: envelopeId, payload, type };
  const data = JSON.stringify(envelope);
  if (piecingOutboxes.get(socket)?.sendInPieces(socket, envelopeId, data)) {
    return;
  }
  socket.send(data);
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
