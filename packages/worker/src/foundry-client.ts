/**
 * HTTP client for the Foundry agent-facing surface (CHAT-01), shared by the
 * `foundry mcp` stdio server and the human/script `foundry session` CLI.
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
  sessionId?: string;
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
    sessionId: overrides.sessionId ?? env("FOUNDRY_SESSION_ID") ?? undefined,
  };
}

export interface AgentProfileLike {
  id: string;
  deviceId: string;
  runtime: string;
  label: string;
  status?: string;
  connectionType?: string;
  baseUrl?: string;
  model?: string;
  models?: string[];
  origin?: string;
  claudeEffort?: string;
  claudePermissionMode?: string;
  codexReasoningEffort?: string;
  codexSandboxMode?: string;
  codexApprovalPolicy?: string;
  codexSpeed?: string;
}

export interface AgentLike {
  id: string;
  workspaceId: string;
  deviceId: string;
  provider: string;
  profileId?: string;
  status?: string;
}

export interface SessionSummary {
  id: string;
  threadId?: string;
  workspaceId: string;
  deviceId: string;
  provider: string;
  profileId?: string;
  profileLabel?: string;
  parentSessionId?: string;
  source?: string;
  status: string;
  title: string;
  prompt?: string;
  response?: string;
  startedAt?: string;
  lastActivityAt?: string;
  completedAt?: string;
  updatedLabel?: string;
  events?: unknown[];
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

  get workspaceId(): string {
    return this.config.workspaceId ?? "";
  }

  get sessionId(): string {
    return this.config.sessionId ?? "";
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

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(
      path.startsWith("/") ? path : `/${path}`,
      this.config.serverURL,
    );
    const init: RequestInit = { method, headers: this.headers() };
    if (body !== undefined) {
      (init.headers as Record<string, string>)["Content-Type"] =
        "application/json";
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await fetch(url.toString(), init);
    } catch (error) {
      throw new FoundryClientError(
        `cannot reach Foundry server at ${this.config.serverURL}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const raw = await response.text();
    if (!response.ok) {
      let detail = raw;
      try {
        detail = JSON.parse(raw).error ?? raw;
      } catch {
        // keep raw body
      }
      throw new FoundryClientError(
        `${method} ${pathnameOf(url)} -> ${response.status}: ${detail}`,
        response.status,
      );
    }
    if (!raw) return undefined as T;
    return JSON.parse(raw) as T;
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

  // --- Profiles / agents -------------------------------------------------

  async listProfiles(runtime?: string): Promise<AgentProfileLike[]> {
    const profiles = await this.request<AgentProfileLike[]>(
      "GET",
      "/api/agent-profiles",
    );
    return runtime
      ? profiles.filter((profile) => profile.runtime === runtime)
      : profiles;
  }

  async listAgents(): Promise<AgentLike[]> {
    const params = new URLSearchParams();
    if (this.workspaceId) params.set("workspaceId", this.workspaceId);
    return this.request<AgentLike[]>("GET", `/api/agents?${params.toString()}`);
  }

  // --- Sessions ----------------------------------------------------------

  async listSessions(): Promise<SessionSummary[]> {
    const params = new URLSearchParams();
    if (this.workspaceId) params.set("workspaceId", this.workspaceId);
    return this.request<SessionSummary[]>(
      "GET",
      `/api/agent-sessions?${params.toString()}`,
    );
  }

  async listChildren(parentSessionId: string): Promise<SessionSummary[]> {
    const sessions = await this.listSessions();
    return sessions.filter(
      (session) => session.parentSessionId === parentSessionId,
    );
  }

  async getSession(id: string): Promise<SessionSummary> {
    return this.request<SessionSummary>("GET", `/api/agent-sessions/${id}`);
  }

  async getThread(id: string): Promise<SessionSummary[]> {
    const params = new URLSearchParams();
    if (this.workspaceId) params.set("workspaceId", this.workspaceId);
    return this.request<SessionSummary[]>(
      "GET",
      `/api/agent-session-threads/${id}?${params.toString()}`,
    );
  }

  async getChat(id: string): Promise<unknown> {
    return this.request("GET", `/api/chats/${id}`);
  }

  async listSubagents(id: string): Promise<unknown> {
    return this.request("GET", `/api/agent-sessions/${id}/subagents`);
  }

  async createSession(input: {
    prompt: string;
    profileId?: string;
    provider?: string;
    model?: string;
    threadId?: string;
    importedContext?: string;
    issueId?: string;
    forkSessionId?: string;
    verification?: boolean;
    claudeEffort?: string;
    claudePermissionMode?: string;
    codexReasoningEffort?: string;
    codexSandboxMode?: string;
    codexApprovalPolicy?: string;
    codexSpeed?: string;
  }): Promise<SessionSummary> {
    if (!this.workspaceId && this.config.sessionToken) {
      throw new FoundryClientError("session token has no workspace id");
    }
    if (input.forkSessionId) {
      // The server inherits agent/provider/profile from the forked session.
      return this.request<SessionSummary>("POST", "/api/agent-sessions", {
        workspaceId: this.workspaceId,
        prompt: input.prompt,
        forkSessionId: input.forkSessionId,
        ...(input.verification ? { verification: true } : {}),
      });
    }
    const agents = await this.listAgents();
    let agent: AgentLike | undefined;
    if (input.profileId) {
      agent = agents.find((item) => item.profileId === input.profileId);
    }
    if (!agent && input.provider) {
      agent = agents.find((item) => item.provider === input.provider);
    }
    if (!agent) {
      agent = agents[0];
    }
    if (!agent) {
      throw new FoundryClientError(
        "no connected agent is available for this workspace",
        409,
      );
    }
    const body: Record<string, unknown> = {
      workspaceId: this.workspaceId,
      agentId: agent.id,
      provider: agent.provider,
      prompt: input.prompt,
    };
    if (input.verification) body.verification = true;
    if (input.forkSessionId) body.forkSessionId = input.forkSessionId;
    const optional = [
      "profileId",
      "model",
      "threadId",
      "importedContext",
      "issueId",
      "claudeEffort",
      "claudePermissionMode",
      "codexReasoningEffort",
      "codexSandboxMode",
      "codexApprovalPolicy",
      "codexSpeed",
    ] as const;
    for (const key of optional) {
      const value = input[key];
      if (value !== undefined && value !== "") body[key] = value;
    }
    if (input.profileId) body.profileId = input.profileId;
    return this.request<SessionSummary>("POST", "/api/agent-sessions", body);
  }

  async handoffSession(input: {
    fromSessionId: string;
    prompt: string;
    profileId?: string;
    issueId?: string;
  }): Promise<SessionSummary> {
    // A factual handoff: carry only facts (goal, final response, status), not
    // the contaminated transcript, into a fresh independent session.
    const source = await this.getSession(input.fromSessionId);
    const facts = [
      `Handoff from session ${source.id} ("${source.title ?? ""}", status: ${source.status}).`,
      source.prompt ? `Original goal:\n${source.prompt}` : "",
      source.response ? `Last recorded result:\n${source.response}` : "",
      input.prompt,
    ]
      .filter(Boolean)
      .join("\n\n");
    return this.createSession({
      prompt: facts,
      profileId: input.profileId,
      issueId: input.issueId,
    });
  }

  async adopt(
    targetSessionId: string,
    supervisorSessionId: string,
  ): Promise<SessionSummary> {
    return this.request(
      "POST",
      `/api/agent-sessions/${targetSessionId}/adopt`,
      { supervisorSessionId },
    );
  }

  async steer(id: string, message: string): Promise<SessionSummary> {
    return this.request("POST", `/api/agent-sessions/${id}/steer`, {
      message,
    });
  }

  async cancel(id: string): Promise<SessionSummary> {
    return this.request("POST", `/api/agent-sessions/${id}/cancel`);
  }

  async rename(id: string, title: string): Promise<unknown> {
    return this.request("POST", `/api/chats/${id}/title`, {
      workspaceId: this.workspaceId,
      title,
    });
  }

  async getLayout(): Promise<{
    revision: number;
    groups: { id: string; name: string }[];
    positions: { chatId: string; groupId: string }[];
  }> {
    const params = new URLSearchParams();
    if (this.workspaceId) params.set("workspaceId", this.workspaceId);
    return this.request("GET", `/api/chat-layout?${params.toString()}`);
  }

  async listGroupSessions(groupId: string): Promise<SessionSummary[]> {
    const layout = await this.getLayout();
    const ids = new Set(
      layout.positions
        .filter((position) => position.groupId === groupId)
        .map((position) => position.chatId),
    );
    const sessions = await this.listSessions();
    return sessions.filter((session) => ids.has(session.id));
  }

  /**
   * Poll until the session reaches one of the requested statuses. SSE is the
   * push transport in the browser; a bounded poll is the dependency-free
   * equivalent for a short-lived CLI/MCP process.
   */
  async waitFor(
    id: string,
    until: string[],
    timeoutMs = 600_000,
    intervalMs = 1_500,
    onTick?: (status: string) => void,
  ): Promise<SessionSummary> {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    for (;;) {
      const session = await this.getSession(id);
      if (session.status !== last) {
        onTick?.(session.status);
        last = session.status;
      }
      if (until.includes(session.status)) return session;
      if (Date.now() >= deadline) {
        throw new FoundryClientError(
          `timed out after ${timeoutMs}ms waiting for ${id} (last status: ${session.status})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

function pathnameOf(url: URL): string {
  return url.pathname;
}
