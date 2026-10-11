/**
 * Client of the server's Foundry tools (`/api/mcp`), shared by the `foundry
 * mcp` stdio bridge and the `foundry` CLI: both reach Foundry only through
 * the tools sessions call, so the tools are the one implementation.
 *
 * Credentials come only from the environment (MCP stdio convention) or, for a
 * local human at the paired device, from the owner-only daemon config. This
 * client never listens on a socket and never persists a token.
 */

import { existsSync, readFileSync } from "node:fs";
import type { DaemonConfig } from "./config.js";
import { foundryStatePath } from "./state-root.js";

export interface FoundryClientConfig {
  serverURL: string;
  /** Session-scoped bearer token (the normal agent path). */
  sessionToken?: string;
  /** Local fallback: this device's credential, acting as its owner. */
  deviceCredential?: string;
  workspaceId?: string;
}

export class FoundryClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FoundryClientError";
  }
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function resolveConfig(
  overrides: Partial<FoundryClientConfig> = {},
): FoundryClientConfig {
  const configPath = foundryStatePath("daemon-config.json");
  let daemonConfig: DaemonConfig | undefined;
  if (existsSync(configPath)) {
    try {
      daemonConfig = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      daemonConfig = undefined;
    }
  }
  return {
    serverURL:
      overrides.serverURL ??
      env("FOUNDRY_SERVER_URL") ??
      daemonConfig?.serverURL ??
      "",
    sessionToken: overrides.sessionToken ?? env("FOUNDRY_SESSION_TOKEN"),
    deviceCredential:
      overrides.deviceCredential ?? daemonConfig?.deviceCredential,
    workspaceId:
      overrides.workspaceId ?? env("FOUNDRY_WORKSPACE_ID") ?? undefined,
  };
}

export class FoundryClient {
  constructor(private readonly config: FoundryClientConfig) {
    if (!config.serverURL) {
      throw new FoundryClientError(
        "no Foundry server URL: set FOUNDRY_SERVER_URL or pair a worker (foundry-worker connect)",
      );
    }
    if (!config.sessionToken && !config.deviceCredential) {
      throw new FoundryClientError(
        "no credentials: set FOUNDRY_SESSION_TOKEN (run inside a Foundry session) or pair a worker on this device",
      );
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.config.sessionToken) {
      headers.Authorization = `Bearer ${this.config.sessionToken}`;
    } else if (this.config.deviceCredential) {
      headers["X-Foundry-Device-Credential"] = this.config.deviceCredential;
    }
    return headers;
  }

  /**
   * A tool call's arguments as the server needs them. Without a session
   * token the server needs the workspace named; a paired device supplies its
   * configured one unless the caller chose another. A session token already
   * means the session's own workspace, and naming it would change what a
   * tool defaults to (handoff_session continues a session in that session's
   * workspace).
   */
  toolArguments(args: Record<string, unknown>): Record<string, unknown> {
    if (
      this.config.sessionToken ||
      !this.config.workspaceId ||
      args.workspaceId
    )
      return args;
    return { ...args, workspaceId: this.config.workspaceId };
  }

  /**
   * Forwards one MCP JSON-RPC message to the server's tool surface and returns
   * its reply, or undefined for a notification the server accepted.
   */
  async mcp(message: unknown): Promise<unknown> {
    const url = new URL("/api/mcp", this.config.serverURL);
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(message),
      });
    } catch (error) {
      throw new FoundryClientError(
        `cannot reach Foundry server at ${this.config.serverURL}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const raw = await response.text();
    if (response.status === 202 && !raw) return undefined;
    let reply: unknown;
    try {
      reply = JSON.parse(raw);
    } catch {
      reply = undefined;
    }
    // Authorization failures are JSON-RPC errors too, so any JSON-RPC body is
    // the answer whatever the HTTP status.
    if (reply && typeof reply === "object" && "jsonrpc" in reply) return reply;
    throw new FoundryClientError(
      `POST /api/mcp -> ${response.status}: ${raw}`,
      response.status,
    );
  }

  /**
   * Calls one of the server's Foundry tools and returns its text; a failed
   * call throws with the server's message.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const reply = (await this.mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: this.toolArguments(args) },
    })) as {
      result?: { content?: { text?: string }[]; isError?: boolean };
      error?: { message?: string };
    };
    if (reply?.error) {
      throw new FoundryClientError(reply.error.message ?? `${name} failed`);
    }
    const text = (reply?.result?.content ?? [])
      .map((item) => item.text ?? "")
      .join("\n");
    if (reply?.result?.isError) throw new FoundryClientError(text);
    return text;
  }
}
