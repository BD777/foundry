/**
 * The worker's own account of each connection to the server: when it opened
 * and closed, who ended it, the socket error, and how long the server had
 * been silent. The last few go to the server with the next registration, so
 * a device that keeps dropping can be explained without access to it. Also
 * the watch that gives up on a server that has gone silent.
 */
import type { WorkerConnectionReport } from "@bd777/foundry-protocol";
import type { Socket } from "node:net";
import type WebSocket from "ws";
import { openLagWindow } from "./stall-monitor.js";

export type { WorkerConnectionReport };

const keptReports = 10;
let pending: WorkerConnectionReport[] = [];
let history: WorkerConnectionReport[] = [];

/** The proxy host the environment names for https, without credentials. */
export function proxyHost(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw =
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.ALL_PROXY ||
    env.all_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy;
  if (!raw?.trim()) return undefined;
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return "unparsable proxy setting";
  }
}

/** Something that can tell how many bytes went over the socket. */
interface ByteCounter {
  bytesRead?: number;
  bytesWritten?: number;
}

/** Tracks one connection from open to close. */
export class ConnectionRecorder {
  private readonly openedAt = Date.now();
  private lastServerData = 0;
  private lastServerPing = 0;
  private gaveUp = false;
  private error = "";
  private counter: ByteCounter | undefined;
  private readonly lag = openLagWindow();

  /** A message or ping arrived from the server. */
  serverData(): void {
    this.lastServerData = Date.now();
  }

  serverPing(): void {
    this.lastServerPing = Date.now();
    this.lastServerData = this.lastServerPing;
  }

  /** The worker ended the connection itself (e.g. the server went silent). */
  workerGaveUp(): void {
    this.gaveUp = true;
  }

  socketError(error: Error & { code?: string }): void {
    this.error = error.code ? `${error.code}: ${error.message}` : error.message;
  }

  /** The TCP socket under the WebSocket, for byte counts. */
  countBytes(counter: ByteCounter | undefined): void {
    this.counter = counter;
  }

  /** Records the close; `code` 1006 means no close frame arrived. */
  closed(code?: number, reason?: string): WorkerConnectionReport {
    const now = Date.now();
    this.lag.close();
    const report: WorkerConnectionReport = {
      openedAt: new Date(this.openedAt).toISOString(),
      closedAt: new Date(now).toISOString(),
      durationMs: now - this.openedAt,
      closedBy: this.gaveUp
        ? "worker"
        : code !== undefined && code !== 1006
          ? "server"
          : "network",
      ...(code !== undefined ? { closeCode: code } : {}),
      ...(reason ? { closeReason: reason.slice(0, 200) } : {}),
      ...(this.error ? { error: this.error.slice(0, 300) } : {}),
      ...(this.lastServerData
        ? { sinceServerDataMs: now - this.lastServerData }
        : {}),
      ...(this.lastServerPing
        ? { sinceServerPingMs: now - this.lastServerPing }
        : {}),
      ...(this.counter?.bytesRead !== undefined
        ? { bytesReceived: this.counter.bytesRead }
        : {}),
      ...(this.counter?.bytesWritten !== undefined
        ? { bytesSent: this.counter.bytesWritten }
        : {}),
      ...(proxyHost() ? { proxy: proxyHost() } : {}),
      ...(this.lag.maxLagMs ? { maxLagMs: this.lag.maxLagMs } : {}),
    };
    pending = [...pending, report].slice(-keptReports);
    history = [...history, report].slice(-keptReports);
    return report;
  }
}

/**
 * Calls `onBytes` whenever bytes from the server arrive, not only once a
 * whole message or ping has been read. ws has no event for part of a frame,
 * so this listens to the TCP socket it reads from, which the handshake
 * response names (`response.socket`). The listener goes on at 'open', after
 * ws's own: added during 'upgrade' it would take any bytes that came with
 * the handshake before ws reads them, and that message would be lost.
 */
export function onServerBytes(socket: WebSocket, onBytes: () => void): void {
  let tcp: Socket | undefined;
  socket.once("upgrade", (response) => {
    tcp = response.socket;
  });
  socket.once("open", () => tcp?.on("data", () => onBytes()));
}

/**
 * Calls `onSilent` once nothing at all has come from the server for
 * `silenceMs` after the socket opened. A connection dropped on the way (a
 * proxy, NAT, or the machine sleeping) never closes on this side. Any
 * arriving bytes count: the server pings from the goroutine that writes its
 * messages, so a large message on a slow link holds the pings back until it
 * is through, while its bytes keep coming. Returns a function that stops
 * watching.
 */
export function watchServerSilence(
  socket: WebSocket,
  silenceMs: number,
  onSilent: () => void,
): () => void {
  let timer: NodeJS.Timeout | undefined;
  let watching = true;
  const expectServer = (): void => {
    if (!watching) return;
    clearTimeout(timer);
    timer = setTimeout(onSilent, silenceMs);
  };
  socket.on("open", expectServer);
  onServerBytes(socket, expectServer);
  return () => {
    watching = false;
    clearTimeout(timer);
  };
}

/** Reports not yet delivered; taking them clears the record. */
export function takeConnectionReports(): WorkerConnectionReport[] {
  const taken = pending;
  pending = [];
  return taken;
}

/** The last few connections, delivered or not, for diagnostics. */
export function recentConnectionReports(): WorkerConnectionReport[] {
  return [...history];
}

/** A registration carrying the connections since the last one. */
export function withConnectionReports<T extends object>(
  registration: T,
): T & { connections?: WorkerConnectionReport[] } {
  const taken = takeConnectionReports();
  return taken.length ? { ...registration, connections: taken } : registration;
}

/** One line for logs and the diagnostics text. */
export function describeConnectionReport(
  report: WorkerConnectionReport,
): string {
  const seconds = (ms?: number) =>
    ms === undefined ? "?" : `${Math.round(ms / 1000)}s`;
  return [
    `lasted ${seconds(report.durationMs)}`,
    `closed by ${report.closedBy}`,
    report.closeCode !== undefined ? `code ${report.closeCode}` : "",
    report.closeReason ? `reason "${report.closeReason}"` : "",
    report.error ? `error ${report.error}` : "",
    `last data from server ${seconds(report.sinceServerDataMs)} before`,
    report.bytesSent || report.bytesReceived
      ? `worker sent ${report.bytesSent ?? 0} bytes, received ${report.bytesReceived ?? 0} bytes`
      : "",
    `proxy ${report.proxy ?? "none"}`,
    report.maxLagMs ? `max event-loop delay ${report.maxLagMs}ms` : "",
  ]
    .filter(Boolean)
    .join(", ");
}
