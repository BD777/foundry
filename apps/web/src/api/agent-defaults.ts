import { request } from "./http";

/**
 * Default agents (DEV-068): the account, model and effort a session starts
 * with when its start names no account. Mirrors the server's
 * httpapi/agent_defaults.go.
 */
export type AgentDefaultScope = "workspace" | "feishu_bot" | "feishu_chat";

/** Where one part of a resolved default agent came from. */
export type AgentDefaultSource =
  AgentDefaultScope | "last_used" | "personal" | "first_usable";

/** Why a configured account cannot run a session now. */
export type AgentDefaultProblem = "not_signed_in" | "not_ready" | "missing";

export interface AgentDefault {
  workspaceId: string;
  scope: AgentDefaultScope;
  routeId?: string;
  profileId?: string;
  /** The runtime the model and effort were chosen for. */
  runtime?: string;
  model?: string;
  effort?: string;
  updatedBy?: string;
  updatedAt?: string;
  accountName?: string;
  problem?: AgentDefaultProblem;
}

/** An account of the workspace's device a default may name. */
export interface DefaultAgentAccount {
  profileId: string;
  name: string;
  runtime: string;
  kind: string;
  usable: boolean;
  problem?: string;
  detail?: string;
}

/** What a start naming no account runs as, and where each part came from. */
export interface ResolvedAgentDefault {
  profileId?: string;
  runtime: string;
  accountName: string;
  accountSource: AgentDefaultSource;
  model?: string;
  modelSource?: AgentDefaultSource;
  effort?: string;
  effortSource?: AgentDefaultSource;
  skipped?: {
    source: AgentDefaultSource;
    profileId: string;
    accountName?: string;
    problem: AgentDefaultProblem;
  }[];
}

export interface WorkspaceAgentDefaults {
  workspaceId: string;
  defaults: AgentDefault[];
  accounts: DefaultAgentAccount[];
  /** A new Web chat's, for the signed-in person. */
  effective?: ResolvedAgentDefault;
  /** A new topic's in a Feishu chat without its own default. */
  feishuBot?: ResolvedAgentDefault;
  /** A new topic's in each paired chat, by route id. */
  feishuChats?: Record<string, ResolvedAgentDefault>;
}

export interface SetAgentDefaultInput {
  scope: AgentDefaultScope;
  routeId?: string;
  profileId?: string;
  runtime?: string;
  model?: string;
  effort?: string;
}

const defaultsPath = (workspaceId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/agent-defaults`;

export function getAgentDefaults(
  workspaceId: string,
): Promise<WorkspaceAgentDefaults> {
  return request("GET", defaultsPath(workspaceId));
}

export function setAgentDefault(
  workspaceId: string,
  input: SetAgentDefaultInput,
): Promise<WorkspaceAgentDefaults> {
  return request("PUT", defaultsPath(workspaceId), { body: input });
}
