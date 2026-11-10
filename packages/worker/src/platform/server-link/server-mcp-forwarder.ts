/** Native MCP clients use HTTP directly. Relay only their Foundry endpoint,
 * so the worker's proxy also covers tools without proxying model traffic. */
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { serverWebSocketAgent, serverTransportError } from "./server-proxy.js";
import { protectHTTPPort } from "../protected-http-ports.js";
import { SingleFlight } from "../single-flight.js";
import { errorMessage } from "../utils.js";
import { redactSecrets } from "../secret-redaction.js";

const routes = new Map<string, string>();
const pending = new SingleFlight<() => void>({ keepResolved: true });
const hopHeaders = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function serverMcpURL(url: string): string {
  const target = new URL(url);
  const local = routes.get(target.origin);
  return local ? new URL(target.pathname + target.search, local).href : url;
}

export interface ServerMcpForwarderOptions {
  /** Covers proxy connect, TLS negotiation and the wait for response headers. */
  firstByteTimeoutMs?: number;
  log?: (message: string) => void;
}

/** One loopback listener per process/server. No credentials are stored or added. */
export function startServerMcpForwarder(
  serverURL: string,
  options: ServerMcpForwarderOptions = {},
): Promise<() => void> {
  const origin = new URL(serverURL).origin;
  return pending.run(origin, async () => {
    const target = new URL("/api/mcp", origin);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const firstByteTimeoutMs = options.firstByteTimeoutMs ?? 20_000;
    const logFailure = (phase: string, startedAt: number, error: Error) =>
      (options.log ?? console.error)(
        `${new Date().toISOString()} Foundry MCP forward failed during ${phase} after ${Math.max(0, Date.now() - startedAt)}ms: ${redactSecrets(errorMessage(error)).replace(/\s+/g, " ").slice(0, 500)}`,
      );
    const listener = createServer((incoming, response) => {
      if (incoming.url?.split("?", 1)[0] !== "/api/mcp") {
        response.writeHead(404);
        response.end();
        return;
      }
      const headers = Object.fromEntries(
        Object.entries(incoming.headers).filter(
          ([name]) => !hopHeaders.has(name),
        ),
      );
      const startedAt = Date.now();
      let agent;
      try {
        agent = serverWebSocketAgent(target);
      } catch (error) {
        logFailure("proxy connection", startedAt, error as Error);
        response.writeHead(502, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error:
              "Worker proxy configuration is unavailable. Repair it with foundry-worker proxy set or proxy clear.",
          }),
        );
        return;
      }
      let phase = "proxy connection";
      let loggedFailure = false;
      const logOnce = (error: Error, failurePhase = phase) => {
        if (loggedFailure) return;
        loggedFailure = true;
        logFailure(failurePhase, startedAt, error);
      };
      const outgoing = send(
        target,
        { method: incoming.method, headers, agent },
        (answer) => {
          clearTimeout(firstByteTimer);
          phase = "response body";
          const forwarded = Object.fromEntries(
            Object.entries(answer.headers).filter(
              ([name]) => !hopHeaders.has(name),
            ),
          );
          response.writeHead(answer.statusCode ?? 502, forwarded);
          answer.pipe(response);
          answer.on("error", (error) => {
            logOnce(error);
            response.destroy();
          });
        },
      );
      outgoing.once("socket", (socket) => {
        socket.once("connect", () => {
          phase =
            target.protocol === "https:"
              ? "TLS handshake"
              : "waiting for response";
        });
        socket.once("secureConnect", () => {
          phase = "waiting for response";
        });
      });
      outgoing.once("proxyConnect", () => {
        phase =
          target.protocol === "https:"
            ? "TLS handshake"
            : "waiting for response";
      });
      const firstByteTimer = setTimeout(() => {
        const error = new Error(
          `No response headers within ${firstByteTimeoutMs / 1000}s.`,
        );
        logOnce(error);
        if (response.headersSent) {
          response.destroy();
        } else {
          response.writeHead(504, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: serverTransportError(error, target).message,
            }),
          );
        }
        outgoing.destroy(error);
      }, firstByteTimeoutMs);
      firstByteTimer.unref?.();
      outgoing.once("error", (error) => {
        clearTimeout(firstByteTimer);
        logOnce(error);
        if (response.headersSent || response.writableEnded) {
          response.destroy();
          return;
        }
        response.writeHead(502, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: serverTransportError(error, target).message,
          }),
        );
      });
      incoming.pipe(outgoing);
      incoming.on("aborted", () => {
        clearTimeout(firstByteTimer);
        outgoing.destroy();
      });
      response.on("close", () => {
        clearTimeout(firstByteTimer);
        if (!response.writableEnded) outgoing.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => {
        listener.off("error", reject);
        resolve();
      });
    });
    listener.unref();
    const port = (listener.address() as import("node:net").AddressInfo).port;
    const local = `http://127.0.0.1:${port}`;
    const unprotect = protectHTTPPort(port);
    routes.set(origin, local);
    return () => {
      if (routes.get(origin) === local) routes.delete(origin);
      pending.forget(origin);
      unprotect();
      listener.closeAllConnections();
      listener.close();
    };
  });
}
