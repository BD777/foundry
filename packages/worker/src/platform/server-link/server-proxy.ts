import { Agent as HTTPAgent } from "node:http";
import { Agent as HTTPSAgent } from "node:https";
/** Foundry-server transport only. Never installs a process-global proxy. */
import { lookup } from "node:dns/promises";
import { watchFile, unwatchFile, rmSync } from "node:fs";
import { connect as connectTLS } from "node:tls";
import { isIP } from "node:net";
import { Agent, Dispatcher, ProxyAgent, fetch as undiciFetch } from "undici";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { SocksClient } from "socks";
import { foundryStatePath } from "../state-root.js";
import {
  hardenPrivateFile,
  readJSONFile,
  tryReadJSONFile,
  writeJSON,
} from "../storage.js";

export interface WorkerProxyConfig {
  url: string;
  noProxy?: string;
}
export const workerProxyPath = (): string =>
  foundryStatePath("worker-proxy.json");

export function validateProxyURL(raw: string): string {
  try {
    const url = new URL(raw);
    if (
      !["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol) ||
      !url.hostname ||
      (url.pathname && url.pathname !== "/") ||
      url.search ||
      url.hash
    )
      throw new Error();
    // Validate escaped credentials before any connection can log an error.
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return url.href;
  } catch {
    throw new Error(
      "Invalid worker proxy: use http://, https://, socks5:// or socks5h://host:port (optional user:password@; no path/query).",
    );
  }
}

export function readWorkerProxy(): WorkerProxyConfig | undefined {
  try {
    const path = workerProxyPath();
    const config = readJSONFile<WorkerProxyConfig>(path);
    if (config) {
      if (
        typeof config.url !== "string" ||
        (config.noProxy !== undefined && typeof config.noProxy !== "string")
      )
        throw new Error();
      validateProxyURL(config.url);
      hardenPrivateFile(path);
    }
    lastReadProxy = { config };
    return config;
  } catch (error) {
    // Only the classification leaves: a JSON error quotes the file.
    throw new Error(
      `Worker proxy configuration is unreadable or invalid${readFailureCode(error)}. Use foundry-worker proxy set <url> or proxy clear to repair it.`,
    );
  }
}

/** The last configuration this process read whole; unset before the first. */
let lastReadProxy: { config: WorkerProxyConfig | undefined } | undefined;

function readFailureCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && /^[A-Z_0-9]+$/.test(code))
    return ` (${code})`;
  return error instanceof SyntaxError ? " (malformed JSON)" : "";
}

/**
 * The saved configuration the daemon goes by. A read that fails after one
 * succeeded (a file being rewritten, a transient I/O error) keeps the last
 * configuration read whole: a failed read is not a change, and must not
 * leave the control socket unable to reconnect until the file reads again
 * (DEV-217). Before any read succeeded there is nothing to keep: it throws.
 */
export function savedWorkerProxy(
  log: (message: string) => void = console.error,
): WorkerProxyConfig | undefined {
  const known = lastReadProxy;
  try {
    const config = readWorkerProxy();
    loggedFallback = "";
    return config;
  } catch (error) {
    if (!known) throw error;
    // Every request resolves the proxy: one line per failure, not per request.
    const message = errorText(error);
    if (message !== loggedFallback)
      log(
        `${new Date().toISOString()} ${message} Keeping the configuration read last.`,
      );
    loggedFallback = message;
    return known.config;
  }
}
let loggedFallback = "";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function setWorkerProxy(url: string, noProxy?: string): void {
  writeJSON(workerProxyPath(), {
    url: validateProxyURL(url),
    ...(noProxy !== undefined ? { noProxy } : {}),
  });
}
export function clearWorkerProxy(): void {
  rmSync(workerProxyPath(), { force: true });
}

/** No userinfo, path or query may leave this module. */
export function describeProxy(raw: string): string {
  const url = new URL(validateProxyURL(raw));
  return `${url.protocol}//${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "1080")}`;
}

/**
 * How the Worker reaches the server while the proxy it is configured with
 * keeps failing (DEV-217: a dead proxy in worker-proxy.json kept a device
 * offline for hours). Set and cleared by ServerRouteSupervisor; applies only
 * while the configuration still names that proxy.
 */
export interface ServerRouteFallback {
  /** The configured proxy URL this replaces. */
  configured: string;
  route: "environment" | "direct";
  /** With route environment, the proxy URL the environment names. */
  environmentProxy?: string;
  since: string;
  reason: string;
}

/**
 * Kept in the state root, so the execution host's requests and a restarted
 * Worker take the same route; read per request like worker-proxy.json.
 */
export const serverRoutePath = (): string =>
  foundryStatePath("server-route-fallback.json");
const routeListeners = new Set<() => void>();

export function serverRouteFallback(): ServerRouteFallback | undefined {
  const saved = tryReadJSONFile<ServerRouteFallback>(serverRoutePath());
  return saved &&
    typeof saved.configured === "string" &&
    (saved.route === "direct" ||
      (saved.route === "environment" &&
        typeof saved.environmentProxy === "string"))
    ? saved
    : undefined;
}

/** Switches the route; the control socket reconnects on the new one. */
export function setServerRouteFallback(
  fallback: ServerRouteFallback | undefined,
): void {
  if (fallback) writeJSON(serverRoutePath(), fallback);
  else rmSync(serverRoutePath(), { force: true });
  for (const listener of routeListeners) listener();
}

export function onServerRouteChange(listener: () => void): () => void {
  routeListeners.add(listener);
  return () => routeListeners.delete(listener);
}

/** The fallback for the device's registration, without credentials. */
export function reportedRouteFallback():
  | {
      configured: string;
      route: "environment" | "direct";
      environmentProxy?: string;
      since: string;
      reason: string;
    }
  | undefined {
  const fallback = serverRouteFallback();
  if (!fallback) return undefined;
  return {
    configured: describeProxy(fallback.configured),
    route: fallback.route,
    ...(fallback.environmentProxy
      ? { environmentProxy: describeProxy(fallback.environmentProxy) }
      : {}),
    since: fallback.since,
    reason: fallback.reason,
  };
}

/** The proxy the environment names, the saved setting aside. */
function environmentProxy(env: NodeJS.ProcessEnv): string | undefined {
  return (
    env.FOUNDRY_PROXY ||
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.ALL_PROXY ||
    env.all_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    undefined
  );
}

/**
 * The routes to try, in order, when the configured proxy keeps failing:
 * the environment's proxy when the saved setting overrode a different one,
 * then direct.
 */
export function serverRouteAlternatives(
  target: string | URL,
  env: NodeJS.ProcessEnv = process.env,
): Array<Pick<ServerRouteFallback, "route" | "environmentProxy">> {
  const configured = configuredServerProxy(target, env);
  if (!configured.url) return [];
  const alternatives: Array<
    Pick<ServerRouteFallback, "route" | "environmentProxy">
  > = [];
  const fromEnvironment = environmentProxy(env);
  if (configured.source === "setting" && fromEnvironment) {
    try {
      const proxy = validateProxyURL(fromEnvironment);
      if (proxy !== configured.url)
        alternatives.push({ route: "environment", environmentProxy: proxy });
    } catch {
      // An invalid environment proxy is no alternative.
    }
  }
  alternatives.push({ route: "direct" });
  return alternatives;
}

export function resolveServerProxy(
  target: string | URL,
  env: NodeJS.ProcessEnv = process.env,
): { url?: string; source: string; noProxy: string } {
  const configured = configuredServerProxy(target, env);
  const fallback = configured.url ? serverRouteFallback() : undefined;
  if (!fallback || !configured.url || configured.url !== fallback.configured)
    return configured;
  return {
    ...(fallback.route === "environment" && fallback.environmentProxy
      ? { url: fallback.environmentProxy }
      : {}),
    source: `fallback ${fallback.route}`,
    noProxy: configured.noProxy,
  };
}

/** The route the configuration names, whatever the fallback. */
export function configuredServerProxy(
  target: string | URL,
  env: NodeJS.ProcessEnv = process.env,
): { url?: string; source: string; noProxy: string } {
  const saved = savedWorkerProxy();
  const url = new URL(target);
  // WS uses exactly the same bypass semantics as its HTTP handshake.
  url.protocol =
    url.protocol === "wss:"
      ? "https:"
      : url.protocol === "ws:"
        ? "http:"
        : url.protocol;
  const raw =
    saved?.url ||
    env.FOUNDRY_PROXY ||
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.ALL_PROXY ||
    env.all_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy;
  const noProxy = saved?.noProxy ?? env.NO_PROXY ?? env.no_proxy ?? "";
  // Match NO_PROXY without mutating the parent's environment.
  const bypass = noProxy
    .split(/[\s,]+/)
    .filter(Boolean)
    .some((entry) => {
      if (entry === "*") return true;
      const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry.toLowerCase());
      if (!match) return false;
      const port = url.port || (url.protocol === "https:" ? "443" : "80");
      if (match[2] && match[2] !== port) return false;
      const host = url.hostname.toLowerCase();
      const pattern = match[1]!;
      return pattern.startsWith(".") || pattern.startsWith("*")
        ? host.endsWith(pattern.replace(/^\*/, ""))
        : host === pattern;
    });
  return {
    ...(raw && !bypass ? { url: validateProxyURL(raw) } : {}),
    source: saved
      ? "setting"
      : env.FOUNDRY_PROXY
        ? "FOUNDRY_PROXY"
        : raw
          ? "environment"
          : "direct",
    noProxy,
  };
}

// Pools are bounded; close() drains existing bodies before releasing old sockets.
const pools = new Map<string, Dispatcher>();
const direct = new Agent();
function dispatcherFor(raw?: string): Dispatcher {
  if (!raw) return direct;
  let agent = pools.get(raw);
  if (agent) return agent;
  const url = new URL(raw);
  if (url.protocol.startsWith("http")) agent = new ProxyAgent(raw);
  else {
    agent = new Agent({
      connect(options, done) {
        void (async () => {
          const host = options.hostname.replace(/^\[|\]$/g, "");
          const destination =
            url.protocol === "socks5:" && !isIP(host)
              ? (await lookup(host)).address
              : host;
          const { socket } = await SocksClient.createConnection({
            proxy: {
              host: url.hostname.replace(/^\[|\]$/g, ""),
              port: Number(url.port || 1080),
              type: 5,
              userId: decodeURIComponent(url.username),
              password: decodeURIComponent(url.password),
            },
            command: "connect",
            // undici passes "" for the scheme's default port.
            destination: {
              host: destination,
              port:
                Number(options.port) ||
                (options.protocol === "https:" ? 443 : 80),
            },
            timeout: 30_000,
          });
          if (options.protocol !== "https:") {
            done(null, socket);
            return;
          }
          const tls = connectTLS({
            socket,
            host,
            servername: options.servername || (!isIP(host) ? host : undefined),
          });
          const failed = (error: Error) => done(error, null);
          tls.once("error", failed);
          tls.once("secureConnect", () => {
            tls.removeListener("error", failed);
            done(null, tls);
          });
          tls.setTimeout(30_000, () =>
            tls.destroy(new Error("Proxy target TLS handshake timed out")),
          );
          tls.once("secureConnect", () => tls.setTimeout(0));
        })().catch((error: Error) => done(error, null));
      },
    });
  }
  pools.set(raw, agent);
  if (pools.size > 8) {
    const key = pools.keys().next().value!;
    const old = pools.get(key)!;
    pools.delete(key);
    void old.close();
  }
  return agent;
}

class ServerDispatcher extends Dispatcher {
  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandlers,
  ): boolean {
    try {
      return dispatcherFor(
        resolveServerProxy(String(options.origin)).url,
      ).dispatch(options, handler);
    } catch (error) {
      handler.onError?.(error as Error);
      return false;
    }
  }
}
const dispatcher = new ServerDispatcher();

async function fetchWithWorkerDispatcher(
  input: Parameters<typeof undiciFetch>[0],
  init?: Parameters<typeof undiciFetch>[1],
): Promise<Response> {
  return (await undiciFetch(input, {
    ...init,
    dispatcher,
  } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
}

function safeErrorCode(error: unknown): string {
  const code =
    (error as { cause?: { code?: string }; code?: string })?.cause?.code ??
    (error as { code?: string })?.code;
  return code && /^[A-Z_0-9]+$/.test(code) ? code : "";
}

/** The route a request would take, with no proxy credentials. */
export function outboundRoute(target: string | URL): string {
  const proxy = resolveServerProxy(target).url;
  return proxy ? `proxy ${describeProxy(proxy)}` : "direct";
}

/**
 * Fetch with the Worker's outbound proxy rules and an error safe to show.
 * Use this for downloads whose failure is reported to the person; server
 * requests use serverFetch below for its server-specific wording.
 */
export const workerFetch: typeof fetch = async (input, init) => {
  const target = input instanceof Request ? input.url : String(input);
  try {
    return await fetchWithWorkerDispatcher(
      input as Parameters<typeof undiciFetch>[0],
      init as Parameters<typeof undiciFetch>[1],
    );
  } catch (error) {
    const code = safeErrorCode(error);
    const safe = new Error(
      `Worker outbound request (${outboundRoute(target)}) failed${code ? ` (${code})` : ""}.`,
    );
    safe.name = error instanceof Error ? error.name : "Error";
    if (code) Object.assign(safe, { code });
    throw safe;
  }
};

/**
 * Standard proxy variables for a child program. With a target, this resolves
 * the same setting, environment fallback and NO_PROXY rule as workerFetch;
 * without one, it still exposes a saved Worker proxy to npm, uv, git and
 * extension processes.
 */
export function workerProxyEnvironment(
  target?: string | URL,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next = { ...env };
  const saved = savedWorkerProxy();
  const resolved = target
    ? resolveServerProxy(target, env)
    : {
        url:
          saved?.url ||
          env.FOUNDRY_PROXY ||
          env.HTTPS_PROXY ||
          env.https_proxy ||
          env.ALL_PROXY ||
          env.all_proxy ||
          env.HTTP_PROXY ||
          env.http_proxy,
        noProxy: saved?.noProxy ?? env.NO_PROXY ?? env.no_proxy ?? "",
      };
  if (!target && !saved) return next;
  for (const name of [
    "FOUNDRY_PROXY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
  ])
    delete next[name];
  if (!resolved.url) return next;
  const proxy = validateProxyURL(resolved.url);
  for (const name of [
    "FOUNDRY_PROXY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ])
    next[name] = proxy;
  if (resolved.noProxy) {
    next.NO_PROXY = resolved.noProxy;
    next.no_proxy = resolved.noProxy;
  }
  return next;
}

/**
 * Fetch with per-origin NO_PROXY. It is the fetch of the undici package the
 * dispatcher comes from: Node's own fetch bundles another undici, and Node 26
 * (undici 8) rejects this one's dispatchers in a way that left the request
 * pending forever, so `foundry-worker update` exited 0 having done nothing.
 */
export const serverFetch: typeof fetch = async (input, init) => {
  const target = input instanceof Request ? input.url : String(input);
  const proxy = resolveServerProxy(target).url;
  try {
    return await fetchWithWorkerDispatcher(
      input as Parameters<typeof undiciFetch>[0],
      init as Parameters<typeof undiciFetch>[1],
    );
  } catch (error) {
    if (!proxy) throw error;
    // Libraries can put userinfo in messages/causes. Export only classification.
    const code = safeErrorCode(error);
    const safeCode = code ? ` (${code})` : "";
    const name = error instanceof Error ? error.name : "Error";
    const safe = new Error(
      `Foundry server request via proxy ${describeProxy(proxy)} failed${safeCode}. Check the proxy address, authentication and reachability.`,
    );
    safe.name = name;
    if (code && safeCode) Object.assign(safe, { code });
    throw safe;
  }
};

const directHTTP = new HTTPAgent();
const directHTTPS = new HTTPSAgent();
export function serverWebSocketAgent(target: string | URL): HTTPAgent {
  const raw = resolveServerProxy(target).url;
  if (!raw)
    return /^(https|wss):/.test(String(target)) ? directHTTPS : directHTTP;
  return raw.startsWith("socks")
    ? new SocksProxyAgent(raw)
    : new HttpsProxyAgent(raw);
}

export function serverTransportError(
  error: Error,
  target: string | URL,
): Error {
  try {
    const proxy = resolveServerProxy(target).url;
    return proxy
      ? new Error(
          `Foundry server connection via proxy ${describeProxy(proxy)} failed. Check proxy authentication and reachability.`,
        )
      : error;
  } catch {
    return new Error(
      "Worker proxy configuration is unavailable. Repair it with foundry-worker proxy set or proxy clear.",
    );
  }
}

/** The configuration in words, without credentials. */
function describeSaved(config: WorkerProxyConfig | undefined): string {
  if (!config) return "none saved";
  return `${describeProxy(config.url)}${config.noProxy !== undefined ? ` no-proxy "${config.noProxy}"` : ""}`;
}

/**
 * Changes reconnect only the control socket; execution-host HTTP reads config
 * per request. Only a configuration read whole that differs from the one the
 * connection started with is a change; a read that fails is logged and
 * waited out (DEV-217: one failed read used to end the connection).
 * onChange gets the change in words, without credentials.
 */
export function watchWorkerProxy(
  onChange: (change: string) => void,
  log: (message: string) => void = console.error,
): () => void {
  const path = workerProxyPath();
  let previous: WorkerProxyConfig | undefined;
  try {
    previous = savedWorkerProxy(() => {});
  } catch {
    previous = undefined;
  }
  let previousFingerprint = JSON.stringify(previous ?? null);
  let failing = "";
  const listener = () => {
    let current: WorkerProxyConfig | undefined;
    try {
      current = readWorkerProxy();
    } catch (error) {
      const message = errorText(error);
      if (message !== failing)
        log(
          `${new Date().toISOString()} ${message} Not a change: the connection keeps its configuration.`,
        );
      failing = message;
      return;
    }
    failing = "";
    const fingerprint = JSON.stringify(current ?? null);
    if (fingerprint === previousFingerprint) return;
    const change = `${describeSaved(previous)} -> ${describeSaved(current)}`;
    previous = current;
    previousFingerprint = fingerprint;
    onChange(change);
  };
  watchFile(path, { persistent: false, interval: 1000 }, listener);
  return () => unwatchFile(path, listener);
}

export async function checkServerProxy(
  serverURL: string,
): Promise<{ proxy: string; ms: number; status: number }> {
  const proxy = resolveServerProxy(serverURL).url;
  const started = Date.now();
  const response = await serverFetch(new URL("/healthz", serverURL), {
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (!response.ok)
    throw new Error(`Server health check returned HTTP ${response.status}`);
  return {
    proxy: proxy ? describeProxy(proxy) : "direct",
    ms: Date.now() - started,
    status: response.status,
  };
}
