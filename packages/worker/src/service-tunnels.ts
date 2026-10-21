import { isProtectedHTTPPort } from "./protected-http-ports.js";
import { createConnection } from "node:net";
import { Transform } from "node:stream";
import WebSocket, { createWebSocketStream } from "ws";
import type { ServiceTunnelOpenPayload } from "@bd777/foundry-protocol";

/** Each data connection is an outbound WS, independent of control/RPC traffic.
 * Node streams propagate backpressure both ways; no response body is buffered.
 * TCP destinations are constants plus the explicit registered port, never URLs.
 */
export function validServiceTunnelTarget(
  port: number,
  protocol: string,
  serverURL: string,
): boolean {
  const server = new URL(serverURL);
  const controlPort = Number(
    server.port || (server.protocol === "https:" ? 443 : 80),
  );
  return (
    Number.isInteger(port) &&
    port >= 1024 &&
    port <= 65535 &&
    port !== 31982 &&
    port !== 31983 &&
    port !== controlPort &&
    !isProtectedHTTPPort(port) &&
    (protocol === "http" || protocol === "https")
  );
}

export interface TunnelConnectionOptions {
  serverURL: string;
  headers: Record<string, string>;
  request: ServiceTunnelOpenPayload;
  onClose?: () => void;
  /** Tests may shorten the heartbeat bound; production uses 90 seconds. */
  silenceMs?: number;
}

export function openServiceTunnel(
  options: TunnelConnectionOptions,
): () => void {
  const { request, serverURL } = options;
  if (
    !validServiceTunnelTarget(request.port, request.protocol, serverURL) ||
    !/^[a-f0-9]{64}$/.test(request.streamId)
  )
    throw new Error("Invalid registered loopback service target");
  const remote = new URL(
    `/api/daemon/service-tunnels/${request.streamId}`,
    serverURL,
  );
  remote.protocol = remote.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(remote, {
    headers: options.headers,
    perMessageDeflate: false,
    maxPayload: 64 * 1024,
    handshakeTimeout: 8000,
    followRedirects: false,
  });
  const local = createConnection({ host: "127.0.0.1", port: request.port });
  local.setNoDelay(true);
  const duplex = createWebSocketStream(ws, { highWaterMark: 32 * 1024 });
  // TCP read chunks may exceed a requested highWaterMark. Bound every wire
  // frame independently, including a fast peer's large download chunks.
  const chunks = new Transform({
    highWaterMark: 32 * 1024,
    transform(chunk: Buffer, _encoding, done) {
      for (let start = 0; start < chunk.length; start += 32 * 1024)
        this.push(chunk.subarray(start, start + 32 * 1024));
      done();
    },
  });
  let closed = false;
  const connecting = setTimeout(() => close(), 8000);
  connecting.unref();
  const silence = setTimeout(() => close(), options.silenceMs ?? 90_000);
  silence.unref();
  ws.on("ping", () => silence.refresh());
  ws.on("message", () => silence.refresh());
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(connecting);
    clearTimeout(silence);
    local.destroy();
    chunks.destroy();
    duplex.destroy();
    ws.terminate();
    options.onClose?.();
  };
  local.once("connect", () => clearTimeout(connecting));
  for (const stream of [local, chunks, duplex]) {
    stream.on("error", close);
  }
  // A local FIN must flush the readable pipeline before closing the WS.
  local.once("close", () => {
    if (!local.readableEnded) close();
  });
  duplex.once("close", close);
  ws.on("error", close);
  ws.once("close", close);
  local.pipe(chunks).pipe(duplex).pipe(local);
  return close;
}
