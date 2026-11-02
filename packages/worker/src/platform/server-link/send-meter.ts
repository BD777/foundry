/**
 * What one connection sent and how its socket kept up, for the report the
 * worker gives about it with its next registration (see connection-reports):
 * the bytes of each message type in the first minutes after the connection
 * opened, the session messages carried over from an earlier connection, the
 * fullest the outbox and the socket got, and the longest the socket held
 * bytes the network took none of. On a slow uplink a reconnect is followed by
 * a burst of registrations, scans and replayed events; this says which.
 */
import type { WorkerConnectionReport } from "@bd777/foundry-protocol";

export type ConnectionSendReport = Pick<
  WorkerConnectionReport,
  "sentAfterOpen" | "replayed" | "outboxPeak" | "longestSendStallMs"
>;

/** How long after the open messages are counted by type. */
export const sentAfterOpenWindowMs = 3 * 60_000;

/** Message types reported by name; smaller ones are summed as "other". */
const reportedTypes = 8;

interface TypeCount {
  count: number;
  bytes: number;
}

/** Something sockets can be keyed by: a meter belongs to one socket. */
const meters = new WeakMap<object, SendMeter>();

/** Counts what goes out on socket from now on. */
export function meterSocket(socket: object, meter: SendMeter): void {
  meters.set(socket, meter);
}

/** The meter counting socket's messages, if one is. */
export function socketMeter(socket: object): SendMeter | undefined {
  return meters.get(socket);
}

export class SendMeter {
  private openedAt: number;
  private readonly early = new Map<string, TypeCount>();
  private replayedCount = 0;
  private replayedBytes = 0;
  private peakQueued = 0;
  private peakBuffered = 0;
  private lastProgress = 0;
  private busySince: number | undefined;
  private longestStall = 0;

  constructor(
    private readonly windowMs = sentAfterOpenWindowMs,
    private readonly now: () => number = Date.now,
  ) {
    this.openedAt = now();
  }

  /** The connection opened: the window of counted types starts now. */
  opened(): void {
    this.openedAt = this.now();
  }

  /**
   * A message of type, bytes long, was handed to the socket. replay: an
   * outbox message unacknowledged on an earlier connection.
   */
  sent(type: string, bytes: number, replay = false): void {
    if (replay) {
      this.replayedCount += 1;
      this.replayedBytes += bytes;
    }
    if (this.now() - this.openedAt > this.windowMs) return;
    const entry = this.early.get(type) ?? { count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += bytes;
    this.early.set(type, entry);
  }

  /** The socket finished writing a message to the network. */
  progress(): void {
    this.lastProgress = this.now();
  }

  /**
   * Looks at the socket and the outbox: bufferedBytes the socket holds,
   * queued messages waiting in the outbox. A socket holding bytes with no
   * write finished since it began to is stalled.
   */
  sample(bufferedBytes: number, queued: number): void {
    this.peakQueued = Math.max(this.peakQueued, queued);
    this.peakBuffered = Math.max(this.peakBuffered, bufferedBytes);
    const now = this.now();
    if (bufferedBytes <= 0) {
      this.busySince = undefined;
      return;
    }
    this.busySince ??= now;
    const stalled = now - Math.max(this.lastProgress, this.busySince);
    this.longestStall = Math.max(this.longestStall, stalled);
  }

  report(): ConnectionSendReport {
    const sorted = [...this.early.entries()].sort(
      (left, right) => right[1].bytes - left[1].bytes,
    );
    const types = sorted
      .slice(0, reportedTypes)
      .map(([type, entry]) => ({ type, ...entry }));
    const rest = sorted.slice(reportedTypes);
    if (rest.length) {
      types.push({
        type: "other",
        count: rest.reduce((sum, [, entry]) => sum + entry.count, 0),
        bytes: rest.reduce((sum, [, entry]) => sum + entry.bytes, 0),
      });
    }
    return {
      ...(types.length
        ? { sentAfterOpen: { windowMs: this.windowMs, types } }
        : {}),
      ...(this.replayedCount
        ? {
            replayed: {
              count: this.replayedCount,
              bytes: this.replayedBytes,
            },
          }
        : {}),
      ...(this.peakQueued || this.peakBuffered
        ? {
            outboxPeak: {
              queued: this.peakQueued,
              bufferedBytes: this.peakBuffered,
            },
          }
        : {}),
      ...(this.longestStall ? { longestSendStallMs: this.longestStall } : {}),
    };
  }
}
