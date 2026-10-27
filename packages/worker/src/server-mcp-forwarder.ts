/** Native MCP clients use HTTP directly. Relay only their Foundry endpoint,
 * so the worker's proxy also covers tools without proxying model traffic. */
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { serverWebSocketAgent, serverTransportError } from "./server-proxy.js";
import { protectHTTPPort } from "./protected-http-ports.js";

const routes = new Map<string, string>();
const pending = new Map<string, Promise<() => void>>();
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

/** One loopback listener per process/server. No credentials are stored or added. */
export function startServerMcpForwarder(
  serverURL: string,
): Promise<() => void> {
  const origin = new URL(serverURL).origin;
  const existing = pending.get(origin);
  if (existing) return existing;
  const starting = (async () => {
    const target = new URL("/api/mcp", origin);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
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
      let agent;
      try {
        agent = serverWebSocketAgent(target);
      } catch {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error:
              "Worker proxy configuration is unavailable. Repair it with foundry-worker proxy set or proxy clear.",
          }),
        );
        return;
      }
      const outgoing = send(
        target,
        { method: incoming.method, headers, agent },
        (answer) => {
          const forwarded = Object.fromEntries(
            Object.entries(answer.headers).filter(
              ([name]) => !hopHeaders.has(name),
            ),
          );
          response.writeHead(answer.statusCode ?? 502, forwarded);
          answer.pipe(response);
          answer.on("error", () => response.destroy());
        },
      );
      outgoing.on("error", (error) => {
        if (response.headersSent) {
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
      incoming.on("aborted", () => outgoing.destroy());
      response.on("close", () => {
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
      pending.delete(origin);
      unprotect();
      listener.closeAllConnections();
      listener.close();
    };
  })();
  pending.set(origin, starting);
  void starting.catch(() => pending.delete(origin));
  return starting;
}
