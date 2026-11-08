/**
 * Running a migration transfer in the background (DEV-146): the worker
 * dials its own data WebSocket to the server's relay
 * (GET /api/daemon/migration-streams/{streamId}), speaks the frame
 * protocol on it and reports progress as worker news. One transfer per
 * migration and role; a new one replaces the one running. Nothing but the
 * staging survives a worker restart: the server starts another transfer.
 */

import { Duplex, Transform } from "node:stream";
import WebSocket, { createWebSocketStream } from "ws";
import type {
  WorkspaceMigrationProgressPayload,
  WorkspaceMigrationTransferPayload,
} from "@bd777/foundry-protocol";
import { serverWebSocketAgent } from "../../platform/server-link/server-proxy.js";
import { errorMessage } from "../../platform/utils.js";
import { identifier } from "../../candidate-store/execution-storage.js";
import { frameKinds, writeFrame } from "./framing.js";
import { manifestForTransfer } from "./source.js";
import { runTarget, type TransferProgress } from "./target.js";
import { runSource } from "./source.js";

/** Each WebSocket message the worker sends is at most this long. */
const wireChunk = 32 * 1024;
const pingMs = 20_000;
const silenceMs = 120_000;

export interface MigrationStream {
  stream: Duplex;
  close(): void;
}

/** Opens the data WebSocket of a migration stream. */
export async function dialMigrationStream(input: {
  serverURL: string;
  streamId: string;
  headers: Record<string, string>;
}): Promise<MigrationStream> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.streamId))
    throw new Error("Invalid migration stream id");
  const remote = new URL(
    `/api/daemon/migration-streams/${input.streamId}`,
    input.serverURL,
  );
  remote.protocol = remote.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(remote, {
    headers: input.headers,
    agent: serverWebSocketAgent(remote),
    perMessageDeflate: false,
    maxPayload: 2 * 1024 * 1024,
    handshakeTimeout: 10_000,
    followRedirects: false,
  });
  // Made before the socket opens: a message that arrives with the
  // handshake would otherwise have no listener and be lost.
  const socketStream = createWebSocketStream(ws, {
    highWaterMark: 256 * 1024,
  });
  // A failed handshake is reported by the promise below.
  socketStream.on("error", () => undefined);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    ws.once("open", () => resolveOpen());
    ws.once("error", rejectOpen);
    ws.once("unexpected-response", (_request, response) =>
      rejectOpen(
        new Error(
          `The server refused the migration stream (${response.statusCode})`,
        ),
      ),
    );
  }).catch((error: unknown) => {
    socketStream.destroy();
    ws.terminate();
    throw error;
  });
  const chunks = new Transform({
    highWaterMark: 256 * 1024,
    transform(chunk: Buffer, _encoding, done) {
      for (let start = 0; start < chunk.length; start += wireChunk)
        this.push(chunk.subarray(start, start + wireChunk));
      done();
    },
  });
  chunks.pipe(socketStream);
  const stream = Duplex.from({ readable: socketStream, writable: chunks });
  let closed = false;
  const silence = setTimeout(() => close(), silenceMs);
  silence.unref();
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, pingMs);
  ping.unref();
  for (const event of ["ping", "pong", "message"] as const)
    ws.on(event, () => silence.refresh());
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(silence);
    clearInterval(ping);
    chunks.destroy();
    socketStream.destroy();
    stream.destroy();
    ws.terminate();
  };
  ws.once("close", () => {
    if (!socketStream.readableEnded)
      stream.destroy(new Error("The migration stream closed"));
  });
  // A finished transfer ends its writable side; let it flush, then close.
  chunks.once("end", () => setTimeout(close, 2_000).unref());
  for (const part of [chunks, socketStream]) part.on("error", () => close());
  return { stream, close };
}

interface Running {
  cancel(): void;
  done: Promise<void>;
}

const running = new Map<string, Running>();

function runningKey(migrationId: string, role: string): string {
  return `${migrationId}:${role}`;
}

export function transferRunning(migrationId: string): boolean {
  return [...running.keys()].some((key) => key.startsWith(`${migrationId}:`));
}

/** Stops the migration's transfers on this device, waiting a moment for them. */
export async function cancelMigrationTransfers(
  migrationId: string,
): Promise<void> {
  const stopping: Promise<void>[] = [];
  for (const [key, transfer] of running)
    if (key.startsWith(`${migrationId}:`)) {
      transfer.cancel();
      stopping.push(transfer.done);
    }
  await Promise.race([
    Promise.allSettled(stopping),
    new Promise((done) => setTimeout(done, 5_000).unref()),
  ]);
}

/** Sends progress news at most about once a second, and every final phase. */
function progressSink(
  base: Pick<WorkspaceMigrationProgressPayload, "migrationId" | "role">,
  send: (payload: WorkspaceMigrationProgressPayload) => void,
): (progress: TransferProgress & { error?: string }) => void {
  let last = 0;
  let lastPhase = "";
  return (progress) => {
    const now = Date.now();
    const final = ["received", "sent", "failed"].includes(progress.phase);
    if (!final && progress.phase === lastPhase && now - last < 1_000) return;
    last = now;
    lastPhase = progress.phase;
    send({ ...base, ...progress });
  };
}

/**
 * Starts the transfer in the background and returns at once; its outcome
 * arrives as workspace_migration_progress news.
 */
export async function startMigrationTransfer(
  payload: WorkspaceMigrationTransferPayload,
  options: {
    serverURL: string;
    headers: () => Record<string, string>;
    send: (payload: WorkspaceMigrationProgressPayload) => void;
    dial?: typeof dialMigrationStream;
  },
): Promise<void> {
  identifier(payload.migrationId);
  identifier(payload.workspaceId);
  if (payload.role !== "source" && payload.role !== "target")
    throw new Error(
      "workspace_migration_transfer requires role source or target",
    );
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(payload.streamId ?? ""))
    throw new Error("Invalid migration stream id");
  if (!payload.path)
    throw new Error("workspace_migration_transfer requires path");
  const key = runningKey(payload.migrationId, payload.role);
  const previous = running.get(key);
  if (previous) {
    previous.cancel();
    await Promise.race([
      previous.done.catch(() => undefined),
      new Promise((done) => setTimeout(done, 5_000).unref()),
    ]);
  }
  const report = progressSink(
    { migrationId: payload.migrationId, role: payload.role },
    options.send,
  );
  let connection: MigrationStream | undefined;
  let canceled = false;
  const transfer: Running = {
    cancel: () => {
      canceled = true;
      connection?.close();
    },
    done: Promise.resolve(),
  };
  transfer.done = (async () => {
    try {
      const manifest =
        payload.role === "source"
          ? await manifestForTransfer({
              migrationId: payload.migrationId,
              workspaceId: payload.workspaceId,
              path: payload.path,
              nativeSessions: payload.nativeSessions ?? [],
            })
          : undefined;
      if (canceled) throw new Error("The transfer was replaced or canceled");
      connection = await (options.dial ?? dialMigrationStream)({
        serverURL: options.serverURL,
        streamId: payload.streamId,
        headers: options.headers(),
      });
      if (canceled) throw new Error("The transfer was replaced or canceled");
      try {
        if (manifest)
          await runSource(connection.stream, manifest, { onProgress: report });
        else
          await runTarget(connection.stream, {
            migrationId: payload.migrationId,
            path: payload.path,
            onProgress: report,
          });
      } catch (error) {
        await writeFrame(connection.stream, frameKinds.error, {
          message: errorMessage(error),
        }).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      console.error(
        `Workspace migration ${payload.migrationId} (${payload.role}) failed: ${errorMessage(error)}`,
      );
      report({
        phase: "failed",
        files: 0,
        bytes: 0,
        totalFiles: 0,
        totalBytes: 0,
        error: errorMessage(error),
      });
    } finally {
      connection?.close();
      if (running.get(key) === transfer) running.delete(key);
    }
  })();
  running.set(key, transfer);
}
