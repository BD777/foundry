import type { AgentSessionEvent } from "@bd777/foundry-protocol";
import { errorMessage } from "../../platform/utils.js";

export type FoundryToolsStatus =
  "connected" | "failed" | "starting" | "unknown" | "closed";

/** The runtime-specific part of keeping one Foundry MCP connection alive. */
export interface FoundryToolsConnection {
  status(): Promise<FoundryToolsStatus>;
  reconnect(): Promise<void>;
}

export type FoundryToolsEventEmitter = (
  label: string,
  detail: string,
  level?: AgentSessionEvent["level"],
) => Promise<void> | void;

const retryDelaysMs = [2_000, 5_000, 15_000, 30_000, 60_000] as const;
const retryCeilingMs = 60_000;

/** A capped retry delay with jitter, never above the one-minute ceiling. */
export function foundryToolsRetryDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const base =
    retryDelaysMs[Math.min(Math.max(0, attempt), retryDelaysMs.length - 1)]!;
  const jittered = base * (0.8 + random() * 0.4);
  return Math.min(retryCeilingMs, Math.max(1, Math.floor(jittered)));
}

const supervisors = new Set<FoundryToolsSupervisor>();

/**
 * Owns one process's Foundry MCP connection: reports state transitions once,
 * retries failures with capped backoff, and can be nudged immediately when the
 * worker reconnects to its server.
 */
export class FoundryToolsSupervisor implements FoundryToolsConnection {
  private current: FoundryToolsStatus = "unknown";
  private retryAttempt = 0;
  private retryTimer?: NodeJS.Timeout;
  private reconnectPromise?: Promise<void>;
  private closed = false;
  private readonly retryDelay: (attempt: number) => number;

  constructor(
    private readonly connection: FoundryToolsConnection | undefined,
    private readonly emit: FoundryToolsEventEmitter,
    random: () => number = Math.random,
    retryDelay?: (attempt: number) => number,
  ) {
    this.retryDelay =
      retryDelay ?? ((attempt) => foundryToolsRetryDelayMs(attempt, random));
    supervisors.add(this);
  }

  async status(): Promise<FoundryToolsStatus> {
    if (this.closed) return "closed";
    if (!this.connection || this.reconnectPromise) return this.current;
    try {
      const status = await this.connection.status();
      await this.observe(status);
      return this.current;
    } catch (error) {
      await this.failed(errorMessage(error));
      return this.current;
    }
  }

  async connected(): Promise<void> {
    if (this.closed) return;
    const recovered = this.current === "failed";
    this.current = "connected";
    this.retryAttempt = 0;
    this.clearRetry();
    if (recovered) {
      await this.event(
        "Foundry tools reconnected",
        "The Foundry MCP connection recovered.",
      );
    }
  }

  async failed(detail: string): Promise<void> {
    if (this.closed) return;
    const firstFailure = this.current !== "failed";
    this.current = "failed";
    if (firstFailure) {
      await this.event("Foundry tools unavailable", detail, "warning");
    }
    this.scheduleRetry();
  }

  /** Checks first; a failed connection reconnects now instead of waiting. */
  async checkAndReconnect(): Promise<void> {
    if (this.closed) return;
    const status = await this.status();
    if (status === "failed") await this.reconnect();
  }

  /** Reconnects now, coalescing concurrent nudges from server reconnects. */
  async reconnect(): Promise<void> {
    if (this.closed || !this.connection) return;
    if (this.reconnectPromise) return this.reconnectPromise;
    this.clearRetry();
    const reconnect = this.runReconnect();
    this.reconnectPromise = reconnect;
    try {
      await reconnect;
    } finally {
      if (this.reconnectPromise === reconnect)
        this.reconnectPromise = undefined;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.current = "closed";
    this.clearRetry();
    supervisors.delete(this);
  }

  private async observe(status: FoundryToolsStatus): Promise<void> {
    if (status === "connected") {
      await this.connected();
      return;
    }
    if (status === "failed") {
      await this.failed("The Foundry MCP server reports a failed connection.");
      return;
    }
    if (this.current !== "failed")
      this.current = status === "starting" ? "starting" : "unknown";
  }

  private async runReconnect(): Promise<void> {
    try {
      await this.connection?.reconnect();
      await this.connected();
    } catch (error) {
      await this.failed(errorMessage(error));
    }
  }

  private scheduleRetry(): void {
    if (
      this.closed ||
      !this.connection ||
      this.current !== "failed" ||
      this.retryTimer
    )
      return;
    const delayMs = this.retryDelay(this.retryAttempt);
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.closed && this.current === "failed") void this.reconnect();
    }, delayMs);
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private async event(
    label: string,
    detail: string,
    level?: AgentSessionEvent["level"],
  ): Promise<void> {
    try {
      await this.emit(label, detail, level);
    } catch {
      // Diagnostics must never break the native runtime.
    }
  }
}

/** Reconciles every live runtime after the worker re-registers with its server. */
export async function reconnectRegisteredFoundryTools(): Promise<void> {
  await Promise.allSettled(
    [...supervisors].map((supervisor) => supervisor.checkAndReconnect()),
  );
}

export function claudeFoundryToolsConnection(
  query:
    | {
        mcpServerStatus?: () => Promise<
          Array<{ name: string; status: string }>
        >;
        reconnectMcpServer?: (serverName: string) => Promise<void>;
      }
    | undefined,
): FoundryToolsConnection | undefined {
  if (!query?.mcpServerStatus || !query.reconnectMcpServer) return undefined;
  return {
    async status() {
      const foundry = (await query.mcpServerStatus!()).find(
        (server) => server.name === "foundry",
      );
      if (!foundry) return "failed";
      if (foundry?.status === "connected") return "connected";
      if (foundry?.status === "failed" || foundry?.status === "needs-auth")
        return "failed";
      if (foundry?.status === "pending") return "starting";
      return "unknown";
    },
    async reconnect() {
      await query.reconnectMcpServer!("foundry");
    },
  };
}

interface CodexMcpClient {
  request(method: string, params: unknown): Promise<any>;
}

/** Codex app-server's MCP status and config reload, scoped to one thread. */
export function codexFoundryToolsConnection(
  client: CodexMcpClient,
  threadId: string,
  waitMs = 20_000,
): FoundryToolsConnection {
  const status = async (): Promise<FoundryToolsStatus> => {
    const result = await client.request("mcpServerStatus/list", {
      threadId,
      serverName: "foundry",
      detail: "toolsAndAuthOnly",
    });
    const foundry = result?.data?.find?.(
      (server: { name?: string }) => server.name === "foundry",
    );
    if (!foundry) return "failed";
    if (foundry?.runtimeStatus === "connected") return "connected";
    if (
      foundry?.runtimeStatus === "failed" ||
      foundry?.runtimeStatus === "authenticationRequired" ||
      foundry?.runtimeStatus === "cancelled" ||
      foundry?.runtimeStatus === "disabled" ||
      foundry?.authStatus === "notLoggedIn" ||
      foundry?.toolsError
    )
      return "failed";
    if (
      foundry?.runtimeStatus === "starting" ||
      foundry?.runtimeStatus === "notStarted"
    )
      return "starting";
    return "unknown";
  };
  return {
    status,
    async reconnect() {
      await client.request("config/mcpServer/reload", null);
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        const current = await status();
        if (current === "connected") return;
        if (current === "failed")
          throw new Error(
            "Codex reported that the Foundry MCP server failed to reconnect.",
          );
        await new Promise((resolve) => setTimeout(resolve, 250).unref?.());
      }
      throw new Error(
        `Codex did not reconnect the Foundry MCP server within ${Math.ceil(waitMs / 1000)}s.`,
      );
    },
  };
}
