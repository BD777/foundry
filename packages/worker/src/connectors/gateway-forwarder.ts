import {
  serverWebSocketAgent,
  serverTransportError,
} from "../platform/server-link/server-proxy.js";
import { protectHTTPPort } from "../platform/protected-http-ports.js";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { deviceCredentialHeader } from "../transport/server-http.js";

/**
 * The loopback forwarder between a vendor CLI and Foundry's gateway for its
 * connector (Feishu, Cloudflare: the same transport, whatever the vendor).
 *
 * A session's tool profile names `http://127.0.0.1:<port>` as its base URL
 * (feishu-cli accepts loopback HTTP without any opt-in; cf takes it as its
 * API base). Every
 * request, including the event WebSocket upgrade, is piped unchanged to
 * `<server><gateway path><path>`, with this device's credential added: the
 * stand-in handles the tool holds are useless without it. Bodies stream
 * both ways untouched (multipart uploads, ranged downloads). It listens on
 * 127.0.0.1 only and holds nothing but the device credential it reads per
 * request.
 */

/** Tells the gateway where event connect URLs must point. */
const forwarderHostHeader = "x-foundry-forwarder-host";

const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export interface GatewayForwarderOptions {
  serverURL: string;
  /** The gateway's path on the server (from the session's material). */
  gatewayPath: string;
  /** This device's credential, read per request. */
  credential: () => string | undefined;
  log?: (message: string) => void;
  /** Optional connector-specific admission and ephemeral handle renewal. */
  authorizeHeaders?: (
    headers: IncomingHttpHeaders,
  ) => Promise<Record<string, string>>;
  allowUpgrade?: boolean;
}

export interface GatewayForwarder {
  /** `http://127.0.0.1:<port>`, the tool's base URL. */
  baseURL: string;
  close(): Promise<void>;
}

function forwardedHeaders(
  headers: IncomingHttpHeaders,
  host: string,
  credential: string | undefined,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || hopByHop.has(name)) continue;
    if (name === deviceCredentialHeader.toLowerCase()) continue;
    if (name === forwarderHostHeader) continue;
    out[name] = value;
  }
  if (credential) out[deviceCredentialHeader] = credential;
  out[forwarderHostHeader] = host;
  return out;
}

function failure(response: ServerResponse, message: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(502, { "content-type": "application/json" });
  response.end(
    JSON.stringify({ code: 1, msg: `Foundry forwarder: ${message}` }),
  );
}

export async function startGatewayForwarder(
  options: GatewayForwarderOptions,
): Promise<GatewayForwarder> {
  const server = new URL(options.serverURL);
  const send = server.protocol === "https:" ? httpsRequest : httpRequest;
  const prefix = `${server.pathname.replace(/\/$/, "")}${options.gatewayPath}`;
  const log = options.log ?? (() => {});
  let host = "";

  const target = (incoming: IncomingMessage) => ({
    agent: serverWebSocketAgent(server),
    protocol: server.protocol,
    hostname: server.hostname,
    port: server.port,
    path: `${prefix}${incoming.url ?? "/"}`,
    method: incoming.method,
    headers: forwardedHeaders(incoming.headers, host, options.credential()),
  });

  const listener: Server = createServer(async (incoming, response) => {
    let requestOptions;
    try {
      requestOptions = target(incoming);
    } catch {
      failure(response, "worker proxy configuration is unavailable");
      return;
    }
    if (options.authorizeHeaders) {
      try {
        Object.assign(
          requestOptions.headers,
          await options.authorizeHeaders(incoming.headers),
        );
      } catch {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            success: false,
            errors: [
              {
                message:
                  "The session connector is unavailable. Check its workspace binding.",
              },
            ],
          }),
        );
        return;
      }
    }
    const outgoing = send(requestOptions, (answer) => {
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(answer.headers))
        if (value !== undefined && !hopByHop.has(name)) headers[name] = value;
      response.writeHead(answer.statusCode ?? 502, headers);
      answer.pipe(response);
      answer.on("error", () => response.destroy());
    });
    outgoing.on("error", (error) => {
      log(`Gateway forwarder: ${serverTransportError(error, server).message}`);
      failure(response, "the Foundry server could not be reached");
    });
    incoming.pipe(outgoing);
    incoming.on("aborted", () => outgoing.destroy());
  });

  // The event connection: an HTTP upgrade relayed byte for byte.
  listener.on("upgrade", (incoming, client: Socket, head: Buffer) => {
    if (options.allowUpgrade === false) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    let requestOptions;
    try {
      requestOptions = target(incoming);
    } catch {
      client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      return;
    }
    requestOptions.headers.connection = "Upgrade";
    requestOptions.headers.upgrade = incoming.headers.upgrade ?? "websocket";
    const outgoing = send(requestOptions);
    outgoing.on("upgrade", (answer, upstream: Socket, upstreamHead: Buffer) => {
      const lines = [
        `HTTP/1.1 ${answer.statusCode ?? 101} ${answer.statusMessage ?? "Switching Protocols"}`,
      ];
      for (let index = 0; index < answer.rawHeaders.length; index += 2)
        lines.push(
          `${answer.rawHeaders[index]}: ${answer.rawHeaders[index + 1]}`,
        );
      client.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length) client.write(upstreamHead);
      if (head.length) upstream.write(head);
      upstream.pipe(client).pipe(upstream);
      const close = () => {
        upstream.destroy();
        client.destroy();
      };
      upstream.on("error", close);
      client.on("error", close);
      upstream.on("close", close);
      client.on("close", close);
    });
    outgoing.on("response", (answer) => {
      // Refused: hand the refusal back as a plain HTTP answer.
      const lines = [
        `HTTP/1.1 ${answer.statusCode ?? 502} ${answer.statusMessage ?? ""}`,
        "connection: close",
      ];
      for (let index = 0; index < answer.rawHeaders.length; index += 2) {
        const name = answer.rawHeaders[index]!;
        if (!hopByHop.has(name.toLowerCase()))
          lines.push(`${name}: ${answer.rawHeaders[index + 1]}`);
      }
      client.write(`${lines.join("\r\n")}\r\n\r\n`);
      answer.pipe(client);
    });
    outgoing.on("error", (error) => {
      log(`Gateway forwarder: ${serverTransportError(error, server).message}`);
      client.destroy();
    });
    client.on("error", () => outgoing.destroy());
    outgoing.end();
  });

  await new Promise<void>((resolveListen, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      listener.off("error", reject);
      resolveListen();
    });
  });
  const unprotect = protectHTTPPort((listener.address() as AddressInfo).port);
  listener.once("close", unprotect);
  listener.unref();
  host = `127.0.0.1:${(listener.address() as AddressInfo).port}`;
  return {
    baseURL: `http://${host}`,
    close: () =>
      new Promise<void>((resolveClose) => {
        listener.closeAllConnections?.();
        listener.close(() => resolveClose());
      }),
  };
}
