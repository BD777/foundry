// Operations on leased resources (resource_operate, resource_reset): the
// device side of fencing. Each instance (key) keeps the newest lease
// generation it has seen; requests of older generations are refused
// (stale_lease) even when they arrive late. One provider session serves the
// lease operating an instance, its requests run one at a time, and it is
// reset and closed when a newer generation fences the instance or after it
// idles.

import type {
  ResourceActionResult,
  ResourceOperateRequest,
  ResourceOperateResult,
  ResourceResetRequest,
  ResourceResetResult,
} from "@bd777/foundry-protocol";
import { execBounded } from "./exec.js";
import {
  ProviderError,
  ProviderRegistry,
  type ProviderSession,
} from "./provider.js";
import { createCuaDriverProvider } from "./providers/cua-driver.js";

export const defaultDeadlineMs = 30_000;
export const maxDeadlineMs = 120_000;
export const sessionIdleMs = 5 * 60_000;

interface OpenSession {
  backend: string;
  leaseId: string;
  generation: number;
  session: ProviderSession;
  idleTimer?: NodeJS.Timeout;
}

interface InFlight {
  generation: number;
  controller: AbortController;
}

interface InstanceState {
  fence: number;
  /** The tail of this instance's queue of requests. */
  tail: Promise<unknown>;
  current?: OpenSession;
  inFlight: Set<InFlight>;
}

export interface ResourceOperationsOptions {
  providers?: ProviderRegistry;
  platform?: NodeJS.Platform;
  idleMs?: number;
  /** Shows a notice to the person at the device (macOS: a notification). */
  notify?: (message: string) => Promise<void>;
}

export class ResourceOperations {
  private readonly instances = new Map<string, InstanceState>();
  private readonly providers: ProviderRegistry;
  private readonly platform: NodeJS.Platform;
  private readonly idleMs: number;
  private readonly notify: (message: string) => Promise<void>;

  constructor(options: ResourceOperationsOptions = {}) {
    this.providers =
      options.providers ?? new ProviderRegistry([createCuaDriverProvider()]);
    this.platform = options.platform ?? process.platform;
    this.idleMs = options.idleMs ?? sessionIdleMs;
    this.notify =
      options.notify ?? ((message) => macNotification(message, this.platform));
  }

  /** The generation an instance is fenced at (0 when never seen). */
  fence(key: string): number {
    return this.instances.get(key)?.fence ?? 0;
  }

  async operate(
    request: ResourceOperateRequest,
  ): Promise<ResourceOperateResult> {
    const refused = this.refuse(request);
    if (refused) return refused;
    const state = this.state(request.key);
    if (request.generation < state.fence)
      return stale(request.generation, state.fence);
    if (request.generation > state.fence)
      this.raiseFence(state, request.generation);
    const deadlineMs = Math.min(
      request.deadlineMs > 0 ? request.deadlineMs : defaultDeadlineMs,
      this.providers.get(request.backend)?.maxDeadlineMs ?? maxDeadlineMs,
    );
    const controller = new AbortController();
    const flight: InFlight = { generation: request.generation, controller };
    state.inFlight.add(flight);
    const timer = setTimeout(
      () =>
        controller.abort(
          new ProviderError(
            "timeout",
            `the operation ran past its ${deadlineMs} ms deadline`,
          ),
        ),
      deadlineMs,
    );
    timer.unref();
    const run = state.tail.then(() =>
      this.run(state, request, controller.signal),
    );
    state.tail = run.catch(() => undefined);
    try {
      return await run;
    } catch (error) {
      return {
        results: [],
        error: error instanceof Error ? error.message : String(error),
        errorCode:
          error instanceof ProviderError ? error.code : "backend_error",
      };
    } finally {
      clearTimeout(timer);
      state.inFlight.delete(flight);
    }
  }

  /**
   * Fences an instance at generation: older requests are aborted and
   * refused, the older lease's session is reset and closed.
   */
  async reset(request: ResourceResetRequest): Promise<ResourceResetResult> {
    const result: ResourceResetResult = {
      resourceId: request.resourceId,
      generation: request.generation,
    };
    try {
      const state = this.state(request.key);
      if (request.generation > state.fence)
        this.raiseFence(state, request.generation);
      const current = state.current;
      if (current && current.generation < request.generation) {
        state.current = undefined;
        await this.end(current);
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
    if (request.notify)
      await this.notify(request.notify).catch(() => undefined);
    return result;
  }

  /** Aborts everything and closes every session (disconnect, shutdown). */
  async closeAll(): Promise<void> {
    const ending: Promise<void>[] = [];
    for (const state of this.instances.values()) {
      for (const flight of state.inFlight)
        flight.controller.abort(
          new ProviderError(
            "aborted",
            "the worker disconnected from the server",
          ),
        );
      if (state.current) ending.push(this.end(state.current));
      state.current = undefined;
    }
    await Promise.all(ending);
  }

  private refuse(
    request: ResourceOperateRequest,
  ): ResourceOperateResult | undefined {
    const provider = this.providers.get(request.backend);
    if (!provider)
      return {
        results: [],
        errorCode: "backend_unsupported",
        error: `this worker has no ${request.backend || "(unnamed)"} backend`,
      };
    if (provider.type !== request.type)
      return {
        results: [],
        errorCode: "backend_unsupported",
        error: `${provider.id} operates ${provider.type}, not ${request.type}`,
      };
    if (!provider.platforms.includes(this.platform))
      return {
        results: [],
        errorCode: "unsupported_platform",
        error: `${provider.id} does not run on ${this.platform}`,
      };
    if (!Array.isArray(request.actions) || request.actions.length === 0)
      return {
        results: [],
        errorCode: "invalid_request",
        error: "no actions to run",
      };
    return undefined;
  }

  private async run(
    state: InstanceState,
    request: ResourceOperateRequest,
    signal: AbortSignal,
  ): Promise<ResourceOperateResult> {
    // A reset or a newer lease may have come while this one waited.
    if (request.generation < state.fence)
      return stale(request.generation, state.fence);
    if (signal.aborted) return aborted(signal);
    let opened = false;
    let current = state.current;
    if (
      !current ||
      !current.session.alive ||
      current.backend !== request.backend ||
      current.leaseId !== request.leaseId ||
      current.generation !== request.generation
    ) {
      if (current) {
        state.current = undefined;
        await this.end(current);
      }
      const provider = this.providers.get(request.backend)!;
      const session = await provider.open(request.key, {
        id: request.leaseId,
        generation: request.generation,
      });
      current = {
        backend: request.backend,
        leaseId: request.leaseId,
        generation: request.generation,
        session,
      };
      if (request.generation < state.fence || signal.aborted) {
        await this.end(current);
        return signal.aborted
          ? aborted(signal)
          : stale(request.generation, state.fence);
      }
      state.current = current;
      opened = true;
    }
    if (current.idleTimer) clearTimeout(current.idleTimer);
    const results: ResourceActionResult[] = [];
    for (const action of request.actions) {
      if (signal.aborted) {
        const reason = abortReason(signal);
        results.push({
          op: action.op,
          ok: false,
          errorCode: reason.code,
          error: reason.message,
        });
        break;
      }
      const result = await current.session.invoke(action, signal);
      results.push(result);
      if (!result.ok) break;
    }
    if (state.current === current) this.idle(state, current);
    return { results, ...(opened ? { opened } : {}) };
  }

  private idle(state: InstanceState, open: OpenSession): void {
    const idleMs = this.providers.get(open.backend)?.idleCloseMs ?? this.idleMs;
    if (idleMs === 0) return;
    open.idleTimer = setTimeout(() => {
      if (state.current !== open) return;
      state.current = undefined;
      void this.end(open);
    }, idleMs);
    open.idleTimer.unref();
  }

  private async end(open: OpenSession): Promise<void> {
    if (open.idleTimer) clearTimeout(open.idleTimer);
    await open.session.reset().catch(() => undefined);
    await open.session.close().catch(() => undefined);
  }

  private raiseFence(state: InstanceState, generation: number): void {
    state.fence = generation;
    for (const flight of state.inFlight)
      if (flight.generation < generation)
        flight.controller.abort(
          new ProviderError(
            "stale_lease",
            `lease generation ${flight.generation} was superseded by ${generation}`,
          ),
        );
  }

  private state(key: string): InstanceState {
    let state = this.instances.get(key);
    if (!state) {
      state = { fence: 0, tail: Promise.resolve(), inFlight: new Set() };
      this.instances.set(key, state);
    }
    return state;
  }
}

function stale(generation: number, fence: number): ResourceOperateResult {
  return {
    results: [],
    errorCode: "stale_lease",
    error: `lease generation ${generation} is older than this resource's ${fence}`,
  };
}

function abortReason(signal: AbortSignal): ProviderError {
  return signal.reason instanceof ProviderError
    ? signal.reason
    : new ProviderError("aborted", "the operation was aborted");
}

function aborted(signal: AbortSignal): ResourceOperateResult {
  const reason = abortReason(signal);
  return { results: [], errorCode: reason.code, error: reason.message };
}

/** A macOS notification titled Foundry; nothing elsewhere. */
export async function macNotification(
  message: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== "darwin") return;
  const quoted = (text: string): string =>
    `"${text
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/[\r\n]+/g, " ")}"`;
  await execBounded(
    "/usr/bin/osascript",
    [
      "-e",
      `display notification ${quoted(message.slice(0, 400))} with title "Foundry"`,
    ],
    { timeoutMs: 5000 },
  );
}
