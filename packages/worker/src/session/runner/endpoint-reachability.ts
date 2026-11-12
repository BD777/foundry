/**
 * A custom model endpoint that this device cannot reach (an address on another
 * network, a closed port) leaves Claude Code in its connect attempt for the
 * whole API timeout and its retries: the turn shows "generating" for about
 * twelve minutes before the watchdog speaks. A TCP connect to the endpoint's
 * host takes seconds, sends nothing to the provider and tells the person at
 * once. Nothing is probed when a proxy is configured, because the agent then
 * reaches the endpoint through it rather than directly.
 */
import { connect } from "node:net";

export const endpointConnectTimeoutMs = 10_000;

const proxyVariables = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
];

type EnvironmentMap = Record<string, string | undefined>;

export type EndpointConnector = (
  host: string,
  port: number,
  timeoutMs: number,
) => Promise<void>;

export function connectTcp(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const finish = (error?: Error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(timeoutMs, () =>
      finish(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`)),
    );
    socket.once("connect", () => finish());
    socket.once("error", (error) => finish(error));
  });
}

/** The host and port Claude Code would connect to directly, if any. */
export function directEndpoint(
  env: EnvironmentMap,
): { host: string; port: number } | undefined {
  const raw = env.ANTHROPIC_BASE_URL?.trim();
  if (!raw) return undefined;
  if (proxyVariables.some((name) => env[name]?.trim())) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const port = url.port
    ? Number(url.port)
    : url.protocol === "https:"
      ? 443
      : 80;
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port };
}

/** Rejects with a plain reason when the endpoint's host does not answer. */
export async function assertEndpointReachable(
  env: EnvironmentMap,
  connector: EndpointConnector = connectTcp,
  timeoutMs = endpointConnectTimeoutMs,
): Promise<void> {
  const endpoint = directEndpoint(env);
  if (!endpoint) return;
  try {
    await connector(endpoint.host, endpoint.port, timeoutMs);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The model endpoint ${endpoint.host}:${endpoint.port} is not reachable from this device (${reason}). ` +
        "Check the profile's endpoint address and that this device's network can reach it.",
    );
  }
}
