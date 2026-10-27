import { serverWebSocketAgent, serverTransportError } from "./server-proxy.js";
/**
 * Client of the server's Foundry tools (`/api/mcp`), shared by the `foundry
 * mcp` stdio bridge and the `foundry` CLI: both reach Foundry only through
 * the tools sessions call, so the tools are the one implementation.
 *
 * Credentials come only from the environment (MCP stdio convention) or, for a
 * local human at the paired device, from the owner-only daemon config. This
 * client never listens on a socket and never persists a token.
 *
 * A command an agent runs inside a Foundry session (FOUNDRY_SESSION_ID set)
 * never falls back to the device credential: that would act as the device's
 * owner, beyond the session's reach. Agents use their Foundry tools, whose
 * token their commands do not see.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { daemonConfigPath, type DaemonConfig } from "./config.js";
import { tryReadJSONFile } from "./storage.js";
import { errorMessage } from "./utils.js";

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
  // Best effort, and never changes the file: without a readable config the
  // environment alone decides.
  const daemonConfig = tryReadJSONFile<DaemonConfig>(daemonConfigPath());
  return {
    serverURL:
      overrides.serverURL ??
      env("FOUNDRY_SERVER_URL") ??
      daemonConfig?.serverURL ??
      "",
    sessionToken: overrides.sessionToken ?? env("FOUNDRY_SESSION_TOKEN"),
    deviceCredential:
      overrides.deviceCredential ??
      (insideFoundrySession() ? undefined : daemonConfig?.deviceCredential),
    workspaceId:
      overrides.workspaceId ?? env("FOUNDRY_WORKSPACE_ID") ?? undefined,
  };
}

function insideFoundrySession(): boolean {
  return Boolean(env("FOUNDRY_SESSION_ID"));
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
        insideFoundrySession()
          ? "no credentials inside a Foundry session: use the session's Foundry tools (mcp__foundry__*) instead of the foundry CLI"
          : "no credentials: set FOUNDRY_SESSION_TOKEN (run inside a Foundry session) or pair a worker on this device",
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
    let response: { status: number; text: string };
    try {
      response = await postJSON(
        url,
        this.headers({ "Content-Type": "application/json" }),
        JSON.stringify(message),
      );
    } catch (error) {
      throw new FoundryClientError(
        `cannot reach Foundry server at ${this.config.serverURL}: ${errorMessage(
          error,
        )}`,
      );
    }
    const raw = response.text;
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

/**
 * POSTs a JSON body and reads the whole answer. Not fetch: its client stops
 * waiting for an answer's headers after five minutes, and a tool call may
 * block longer (a compute run, up to 30 minutes; the server bounds each).
 */
function postJSON(
  url: URL,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolveAnswer, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(
      url,
      {
        agent: serverWebSocketAgent(url),
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolveAnswer({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", (error) => reject(serverTransportError(error, url)));
    request.end(body);
  });
}
