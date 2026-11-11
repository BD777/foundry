import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type {
  ConnectorExtensionHTTPRequest,
  ConnectorExtensionHTTPResponse,
} from "@bd777/foundry-protocol";

const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const responseLimit = 16 << 20;

/**
 * Performs one upstream exchange on this device for a server-held connector.
 * The rendered credential exists only in this call's memory; redirects are
 * returned as responses rather than followed.
 */
export async function requestExtensionUpstream(
  request: ConnectorExtensionHTTPRequest,
): Promise<ConnectorExtensionHTTPResponse> {
  const target = new URL(request.url);
  if (
    (target.protocol !== "http:" && target.protocol !== "https:") ||
    !target.hostname ||
    target.username ||
    target.password
  )
    throw new Error("invalid extension upstream URL");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (!hopByHop.has(name.toLowerCase()) && name.toLowerCase() !== "host")
      headers[name] = value;
  }
  let body: Buffer | undefined;
  if (request.body) {
    body = Buffer.from(request.body, "base64");
    headers["content-length"] = String(body.length);
  }
  const timeoutMs =
    Math.min(Math.max(request.timeoutSeconds || 60, 1), 60) * 1000;
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return await new Promise<ConnectorExtensionHTTPResponse>(
    (resolve, reject) => {
      let settled = false;
      const finish = (
        error?: Error,
        value?: ConnectorExtensionHTTPResponse,
      ) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(value!);
      };
      const outgoing = send(
        target,
        { method: request.method, headers, timeout: timeoutMs },
        (incoming) => {
          const chunks: Buffer[] = [];
          let length = 0;
          incoming.on("data", (chunk: Buffer) => {
            length += chunk.length;
            if (length > responseLimit) {
              incoming.destroy(
                new Error("extension upstream response is larger than 16 MiB"),
              );
              return;
            }
            chunks.push(chunk);
          });
          incoming.on("error", (error) => finish(error));
          incoming.on("end", () => {
            const responseHeaders: Record<string, string[]> = {};
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (value === undefined) continue;
              responseHeaders[name] = Array.isArray(value) ? value : [value];
            }
            finish(undefined, {
              status: incoming.statusCode ?? 502,
              headers: responseHeaders,
              body: Buffer.concat(chunks).toString("base64"),
            });
          });
        },
      );
      outgoing.on("timeout", () =>
        outgoing.destroy(new Error("extension upstream request timed out")),
      );
      outgoing.on("error", (error) => finish(error));
      outgoing.end(body);
    },
  );
}
