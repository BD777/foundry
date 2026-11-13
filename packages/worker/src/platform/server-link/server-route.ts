/**
 * Keeps a device reachable when the proxy it is configured with stops
 * working. DEV-217: a test wrote a dead local proxy into worker-proxy.json
 * and the Worker retried through it for three hours, never reaching the
 * server. After enough failed attempts over enough time the Worker tries the
 * environment's proxy (when the saved setting overrode one) and then a direct
 * connection, says so loudly and reports it with its registration. It checks
 * the configured proxy again from time to time and goes back to it once it
 * accepts connections.
 */
import { connectTcp } from "../tcp-connect.js";
import {
  configuredServerProxy,
  describeProxy,
  serverRouteAlternatives,
  serverRouteFallback,
  setServerRouteFallback,
  type ServerRouteFallback,
} from "./server-proxy.js";

export interface ServerRouteOptions {
  serverURL: string;
  /** Failed attempts in a row before trying another route. */
  minFailures?: number;
  /** And for at least this long. */
  minFailingMs?: number;
  /** How often the configured proxy is checked while bypassed. */
  probeIntervalMs?: number;
  now?: () => number;
  log?: (message: string) => void;
  probe?: (host: string, port: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

function proxyAddress(raw: string): { host: string; port: number } {
  const url = new URL(raw);
  const port =
    Number(url.port) ||
    (url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : 1080);
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port };
}

export class ServerRouteSupervisor {
  private failures = 0;
  private failingSince: number | undefined;
  private pending: Array<
    Pick<ServerRouteFallback, "route" | "environmentProxy">
  > = [];
  private lastProbe = 0;
  private probing = false;
  private readonly minFailures: number;
  private readonly minFailingMs: number;
  private readonly probeIntervalMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly probe: (host: string, port: number) => Promise<void>;

  constructor(private readonly options: ServerRouteOptions) {
    this.minFailures = options.minFailures ?? 5;
    this.minFailingMs = options.minFailingMs ?? 2 * 60_000;
    this.probeIntervalMs = options.probeIntervalMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? console.error;
    this.probe =
      options.probe ?? ((host, port) => connectTcp(host, port, 10_000));
  }

  /** One connection attempt ended; reached: the server answered on it. */
  attemptEnded(reached: boolean): void {
    const configured = configuredServerProxy(
      this.options.serverURL,
      this.options.env,
    ).url;
    const fallback = serverRouteFallback();
    if (fallback && fallback.configured !== configured) {
      // The configuration changed: the new one gets its chance.
      this.log(
        `${new Date(this.now()).toISOString()} The Worker proxy configuration changed; no longer going around ${describeProxy(fallback.configured)}.`,
      );
      setServerRouteFallback(undefined);
      this.reset();
    }
    if (reached) {
      // A route that works is kept, and with it what is left to try.
      this.failures = 0;
      this.failingSince = undefined;
      return;
    }
    if (!configured) return;
    const now = this.now();
    this.failures += 1;
    this.failingSince ??= now;
    if (serverRouteFallback()) {
      if (this.failures >= this.minFailures)
        this.next(
          configured,
          `${this.failures} attempts on the alternative route failed too`,
        );
      return;
    }
    if (
      this.failures < this.minFailures ||
      now - this.failingSince < this.minFailingMs
    )
      return;
    this.pending = serverRouteAlternatives(
      this.options.serverURL,
      this.options.env,
    );
    this.next(
      configured,
      `${this.failures} connection attempts through ${describeProxy(configured)} failed over ${Math.round((now - this.failingSince) / 1000)}s`,
    );
  }

  /** Checks the bypassed proxy; going back to it when it accepts connections. */
  async checkConfigured(): Promise<void> {
    const fallback = serverRouteFallback();
    if (!fallback || this.probing) return;
    const now = this.now();
    if (now - this.lastProbe < this.probeIntervalMs) return;
    this.lastProbe = now;
    this.probing = true;
    try {
      const { host, port } = proxyAddress(fallback.configured);
      await this.probe(host, port);
      const current = serverRouteFallback();
      if (
        current?.configured !== fallback.configured ||
        current.since !== fallback.since
      )
        return;
      this.log(
        `${new Date(this.now()).toISOString()} The Worker proxy ${describeProxy(fallback.configured)} accepts connections again; reconnecting through it.`,
      );
      this.reset();
      setServerRouteFallback(undefined);
    } catch {
      // Still unreachable: stay on the alternative.
    } finally {
      this.probing = false;
    }
  }

  private next(configured: string, reason: string): void {
    const alternative = this.pending.shift();
    if (!alternative) {
      this.log(
        `${new Date(this.now()).toISOString()} No route around the Worker proxy ${describeProxy(configured)} reached the server; trying it again.`,
      );
      setServerRouteFallback(undefined);
      this.reset();
      return;
    }
    const fallback: ServerRouteFallback = {
      configured,
      ...alternative,
      since: new Date(this.now()).toISOString(),
      reason,
    };
    this.lastProbe = this.now();
    this.failures = 0;
    this.failingSince = undefined;
    this.log(
      `${fallback.since} WORKER PROXY UNREACHABLE: ${reason}. Connecting ${alternative.route === "direct" ? "directly, without a proxy" : `through the environment's proxy ${describeProxy(alternative.environmentProxy!)}`} until it works again; the device page shows this. Fix or clear it with foundry-worker proxy set/clear.`,
    );
    setServerRouteFallback(fallback);
  }

  private reset(): void {
    this.failures = 0;
    this.failingSince = undefined;
    this.pending = [];
  }
}
