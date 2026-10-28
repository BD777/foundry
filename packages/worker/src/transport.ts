// WebSocket transport to the Foundry server: envelope sending and the
// reliable session outbox. Plain HTTP requests are in server-http.ts.

import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type { SessionOutboxStore } from "./session-outbox-store.js";
import {
  daemonMessageTypes,
  processLabels,
  sessionTurnsFeature,
  type ProtocolEnvelope,
} from "@bd777/foundry-protocol";
import { socketMeter } from "./send-meter.js";

interface WebSocketSender {
  readonly readyState: number;
  /** Bytes the socket holds that the network has not taken yet. */
  readonly bufferedAmount?: number;
  send(data: string, callback?: (error?: Error) => void): unknown;
}

interface PendingSessionEnvelope {
  type: string;
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
  /** Unacknowledged when the socket it goes on was bound (see send-meter). */
  replay: boolean;
  /** Progress of a large reliable envelope on this socket. */
  piece?: { sent: number; seq: number };
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
  store?: SessionOutboxStore;
  onAcknowledged?: (id: string) => void;
  onEnqueued?: (envelope: ProtocolEnvelope) => void;
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
  /** Each bulk piece waits for a remote credit, keeping the TCP queue short. */
  replyChunkAck?: boolean;
  /** It takes workspace_folders news (folders gone or back). */
  workspaceFolders?: boolean;
  /** It takes resources_report (the device's resource inventory). */
  resources?: boolean;
  /** It takes session_turn (the turns an agent runs on its own). */
  sessionTurns?: boolean;
  /** It takes execution_runner (the session runner and its switch). */
  runnerReports?: boolean;
}

/** The server's registered answer as features; an older server sends none. */
export function serverFeatures(payload: unknown): ServerFeatures {
  const features =
    payload && typeof payload === "object"
      ? (payload as { features?: unknown }).features
      : undefined;
  return {
    replyChunks: Array.isArray(features) && features.includes("reply_chunks"),
    replyChunkAck:
      Array.isArray(features) && features.includes("reply_chunk_ack"),
    workspaceFolders:
      Array.isArray(features) && features.includes("workspace_folders"),
    resources: Array.isArray(features) && features.includes("resources_v1"),
    sessionTurns:
      Array.isArray(features) && features.includes(sessionTurnsFeature),
    runnerReports:
      Array.isArray(features) && features.includes("runner_reports"),
  };
}

/** A large envelope going out in pieces. */
interface PiecedEnvelope {
  interactive?: boolean;
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
  // A turn Claude runs on its own keeps its session's resource leases
  // active from when it starts; the server takes it in any order with the
  // session's input (a completed input leaves the leases of a running one).
  daemonMessageTypes.sessionTurn,
]);

// At 10 KB/s (a slow uplink) 64 KB is ~6 s ahead of any reply.
const defaultHighWaterMarkBytes = 64 * 1024;
const bulkPieceChars = 4096;
const interactiveReplyTypes = new Set<string>([
  daemonMessageTypes.attachmentChunkRead,
  daemonMessageTypes.fileRead,
  daemonMessageTypes.sessionFileRead,
  daemonMessageTypes.sessionFileDiffRead,
]);
const directControlTypes = new Set<string>([
  daemonMessageTypes.heartbeat,
  daemonMessageTypes.readyForIssue,
  daemonMessageTypes.sessionSteered,
  daemonMessageTypes.sessionCanceled,
]);
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

/** A byte-bounded bulk frame, including JSON escaping and Unicode. */
function envelopePiece(
  id: string,
  source: string,
  sent: number,
  seq: number,
  characters: number,
  maxBytes?: number,
) {
  let end = Math.min(sent + characters, source.length);
  for (;;) {
    const last = source.charCodeAt(end - 1);
    if (end < source.length && last >= 0xd800 && last <= 0xdbff) end--;
    if (end === sent) end = sent + (source.codePointAt(sent)! > 0xffff ? 2 : 1);
    const data = JSON.stringify({
      type: daemonMessageTypes.replyChunk,
      payload: {
        id,
        seq,
        ...(end === source.length ? { last: true } : {}),
        data: source.slice(sent, end),
      },
    });
    const bytes = Buffer.byteLength(data);
    if (!maxBytes || bytes <= maxBytes) return { end, data };
    end =
      sent + Math.max(1, Math.floor(((end - sent) * (maxBytes - 256)) / bytes));
  }
}

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
 * the high-water mark and one piece. With reply_chunk_ack, bulk traffic
 * instead has one 4 KiB piece outstanding until remote receipt; kernel
 * acceptance alone cannot fill the TCP queue. Interactive file replies go
 * ahead of scans and session snapshots. Pieces belong to their socket: like
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
  private pacedBulk = false;
  private bulkCredit?: { id: string; seq?: number };

  constructor(private readonly options: ReliableSessionTransportOptions = {}) {
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
    for (const envelope of options.store?.read() ?? [])
      this.send(envelope.type, envelope.payload, envelope.id);
  }

  /**
   * Carries the outbox on socket from now on. features is what the server
   * said it takes; large envelopes go in pieces only to a server that takes
   * them.
   */
  bind(socket: WebSocketSender, features: ServerFeatures = {}): void {
    this.pacedBulk = features.replyChunkAck === true;
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
    this.bulkCredit = undefined;
    // A new connection carries everything unacknowledged again, in order.
    this.clearFailureRetries();
    this.urgent.clear();
    this.queued.clear();
    for (const [id, entry] of this.pending) {
      entry.failures = 0;
      entry.writtenAt = undefined;
      entry.resent = false;
      entry.replay = true;
      entry.piece = undefined;
      (entry.urgent ? this.urgent : this.queued).add(id);
    }
    this.pump();
  }

  unbind(socket: WebSocketSender): void {
    if (this.socket === socket) {
      piecingOutboxes.delete(socket);
      this.pieced.length = 0;
      this.bulkCredit = undefined;
      this.socket = undefined;
      this.clearDrainCheck();
      this.clearAnswerCheck();
      this.settle();
    }
  }

  send(type: string, payload?: unknown, knownId?: string): string {
    const id =
      knownId ??
      (this.options.store
        ? `session_${Date.now()}_${String(++this.sequence).padStart(10, "0")}_${randomUUID()}`
        : `session_${Date.now()}_${++this.sequence}`);
    if (this.pending.has(id)) return id;
    const envelope: ProtocolEnvelope = {
      id,
      payload,
      type,
    };
    // Persist before publishing or dropping a superseded event.
    this.options.store?.put(envelope);
    this.options.onEnqueued?.(envelope);
    const coalesceKey = sessionEnvelopeCoalesceKey(type, payload);
    if (coalesceKey) {
      const previousId = this.coalescedEnvelopeIds.get(coalesceKey);
      if (previousId) {
        // Finish an envelope already started in pieces: abandoning it would
        // leave an incomplete assembly on the server. Newer unsent snapshots
        // still coalesce while this one drains.
        if (!this.pending.get(previousId)?.piece) this.forget(previousId);
      }
      this.coalescedEnvelopeIds.set(coalesceKey, id);
    }
    const entry: PendingSessionEnvelope = {
      type,
      coalesceKey,
      data: JSON.stringify(envelope),
      failures: 0,
      queuedAt: this.now(),
      resent: false,
      replay: false,
      urgent: urgentSessionMessageTypes.has(type),
    };
    this.pending.set(id, entry);
    (entry.urgent ? this.urgent : this.queued).add(id);
    this.pump();
    return id;
  }

  acknowledgePiece(
    id: string | undefined,
    seq: number,
    socket?: WebSocketSender,
  ): void {
    if (socket && socket !== this.socket) return;
    if (
      this.bulkCredit &&
      this.bulkCredit.id === id &&
      this.bulkCredit.seq === seq
    ) {
      this.bulkCredit = undefined;
      this.pump();
    }
  }

  acknowledge(id: string | undefined): void {
    if (
      this.bulkCredit &&
      this.bulkCredit.id === id &&
      this.bulkCredit.seq === undefined
    ) {
      this.bulkCredit = undefined;
      this.pump();
    }
    const entry = id ? this.pending.get(id) : undefined;
    if (!id || !entry) {
      return;
    }
    this.options.onAcknowledged?.(id);
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
    if (this.bulkCredit?.id === id) this.bulkCredit = undefined;
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

  /** Messages waiting to be written to the socket. */
  queuedCount(): number {
    return this.urgent.size + this.queued.size;
  }

  /**
   * Sends one serialized envelope on the bound socket in pieces, taking
   * turns with events and other large envelopes. False when it is small,
   * socket is not the bound one or its server does not take pieces: send it
   * whole.
   */
  sendInPieces(
    socket: WebSocketSender,
    id: string,
    data: string,
    type?: string,
  ): boolean {
    const interactive =
      interactiveReplyTypes.has(type ?? "") ||
      directControlTypes.has(type ?? "");
    if (socket !== this.socket || piecingOutboxes.get(socket) !== this)
      return false;
    if (data.length <= this.pieceChars && (!this.pacedBulk || interactive))
      return false;
    this.pieced.push({
      id,
      data,
      sent: 0,
      seq: 0,
      interactive,
    });
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
    this.options.store?.remove(id);
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
    // Interactive replies overtake queued scans/snapshots. Only one small
    // bulk piece may be awaiting remote receipt, even if the OS accepted it.
    while (this.pieced.some((entry) => entry.interactive)) {
      if ((socket.bufferedAmount ?? 0) >= this.highWaterMarkBytes) {
        this.scheduleDrainCheck();
        return;
      }
      const index = this.pieced.findIndex((entry) => entry.interactive);
      this.pieced.unshift(this.pieced.splice(index, 1)[0]!);
      if (!this.writePiece(socket)) return;
    }
    for (const id of this.urgent) {
      if (
        this.pending.get(id)?.piece &&
        (socket.bufferedAmount ?? 0) >= this.highWaterMarkBytes
      ) {
        this.scheduleDrainCheck();
        return;
      }
      const written = this.write(socket, id);
      if (!written) return;
      if (written === "complete") this.urgent.delete(id);
      else {
        this.scheduleDrainCheck();
        return;
      }
    }
    while (this.queued.size > 0 || this.pieced.length > 0) {
      if (this.pacedBulk && this.bulkCredit) return;
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
      const written = this.write(socket, id);
      if (!written) return;
      if (written === "complete") this.queued.delete(id);
      this.pieceTurn = true;
    }
    this.clearDrainCheck();
  }

  /** Writes the next piece of the first large envelope, which then waits its turn. */
  private writePiece(socket: WebSocketSender): boolean {
    const envelope = this.pieced[0]!;
    const { end, data } = envelopePiece(
      envelope.id,
      envelope.data,
      envelope.sent,
      envelope.seq,
      this.pieceChars,
      this.pacedBulk && !envelope.interactive ? bulkPieceChars : undefined,
    );
    const meter = socketMeter(socket);
    try {
      socket.send(data, () => {
        meter?.progress();
        this.pumpSoon();
      });
    } catch {
      return false;
    }
    if (this.pacedBulk && !envelope.interactive)
      this.bulkCredit = { id: envelope.id, seq: envelope.seq };
    this.pieced.shift();
    envelope.sent = end;
    envelope.seq += 1;
    if (envelope.sent < envelope.data.length) this.pieced.push(envelope);
    return true;
  }

  private write(
    socket: WebSocketSender,
    id: string,
  ): "complete" | "partial" | false {
    const entry = this.pending.get(id);
    if (!entry) return "complete";
    const meter = socketMeter(socket);
    let data = entry.data;
    let progress: { sent: number; seq: number } | undefined;
    if (
      piecingOutboxes.get(socket) === this &&
      (data.length > this.pieceChars ||
        (this.pacedBulk &&
          !entry.urgent &&
          Buffer.byteLength(data) > bulkPieceChars))
    ) {
      const piece = entry.piece ?? { sent: 0, seq: 0 };
      const framed = envelopePiece(
        id,
        data,
        piece.sent,
        piece.seq,
        this.pieceChars,
        this.pacedBulk && !entry.urgent ? bulkPieceChars : undefined,
      );
      progress = { sent: framed.end, seq: piece.seq + 1 };
      data = framed.data;
    }
    try {
      // Reliable events need the same bounded frames as RPC replies. A large
      // transcript snapshot must not hold up file reads or heartbeats.
      socket.send(data, () => {
        meter?.progress();
        this.pumpSoon();
      });
      if (this.pacedBulk && !entry.urgent)
        this.bulkCredit = {
          id,
          ...(progress ? { seq: progress.seq - 1 } : {}),
        };
      if (!entry.piece) {
        meter?.sent(entry.type, Buffer.byteLength(entry.data), entry.replay);
        entry.replay = false;
      }
      if (progress) {
        entry.piece = progress;
        if (progress.sent < entry.data.length) return "partial";
      }
      entry.piece = undefined;
      entry.writtenAt = this.now();
      this.scheduleAnswerCheck();
      return "complete";
    } catch {
      return false;
    }
  }

  private pumpSoon(): void {
    if (
      this.pumpScheduled ||
      (this.urgent.size === 0 &&
        this.queued.size === 0 &&
        this.pieced.length === 0)
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
  const meter = socketMeter(socket);
  meter?.sent(type, Buffer.byteLength(data));
  if (
    piecingOutboxes.get(socket)?.sendInPieces(socket, envelopeId, data, type)
  ) {
    return;
  }
  if (meter) socket.send(data, () => meter.progress());
  else socket.send(data);
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
