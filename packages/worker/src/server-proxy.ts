import { Agent as HTTPAgent } from "node:http";
import { Agent as HTTPSAgent } from "node:https";
/** Foundry-server transport only. Never installs a process-global proxy. */
import { lookup } from "node:dns/promises";
import { watchFile, unwatchFile, rmSync } from "node:fs";
import { connect as connectTLS } from "node:tls";
import { isIP } from "node:net";
import { Agent, Dispatcher, ProxyAgent } from "undici";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { SocksClient } from "socks";
import { foundryStatePath } from "./state-root.js";
import { hardenPrivateFile, readJSONFile, writeJSON } from "./storage.js";

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
    return config;
  } catch {
    throw new Error(
      "Worker proxy configuration is unreadable or invalid. Use foundry-worker proxy set <url> or proxy clear to repair it.",
    );
  }
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

export function resolveServerProxy(
  target: string | URL,
  env: NodeJS.ProcessEnv = process.env,
): { url?: string; source: string; noProxy: string } {
  const saved = readWorkerProxy();
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
            destination: { host: destination, port: Number(options.port) },
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

/** Uses native fetch's streaming, abort and redirect support with per-origin NO_PROXY. */
export const serverFetch: typeof fetch = async (input, init) => {
  const target = input instanceof Request ? input.url : String(input);
  const proxy = resolveServerProxy(target).url;
  try {
    return await fetch(input, { ...init, dispatcher } as RequestInit);
  } catch (error) {
    if (!proxy) throw error;
    // Libraries can put userinfo in messages/causes. Export only classification.
    const code =
      (error as { cause?: { code?: string }; code?: string })?.cause?.code ??
      (error as { code?: string })?.code;
    const safeCode = code && /^[A-Z_0-9]+$/.test(code) ? ` (${code})` : "";
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

/** Changes reconnect only the control socket; execution-host HTTP reads config per request. */
export function watchWorkerProxy(onChange: () => void): () => void {
  const path = workerProxyPath();
  const fingerprint = () => {
    try {
      return JSON.stringify(readWorkerProxy());
    } catch {
      return "invalid";
    }
  };
  let previous = fingerprint();
  const listener = () => {
    const current = fingerprint();
    if (current !== previous) {
      previous = current;
      onChange();
    }
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
