import type { AgentSession } from "@foundry/protocol";
import { isUtilitySession } from "./utils.js";
import {
  baseProcessEnvironment,
  profileID,
  profileRuntimeEnvironment,
  type AgentProfileLocalConfig,
} from "./profiles.js";

/**
 * Per-session ambient environment (CHAT-01).
 *
 * When the daemon dispatches a session it now carries a one-time
 * FOUNDRY_SESSION_TOKEN plus the server URL; the spawned native agent exposes
 * them to its child `foundry mcp` / `foundry session` processes. The values
 * are process-scoped and never written to disk. Registered for the lifetime
 * of one executeAgentSession run, keyed by Foundry session id.
 */

export interface SessionAmbientEnv {
  serverURL: string;
  sessionToken: string;
  workspaceID: string;
}

const ambientBySession = new Map<string, SessionAmbientEnv>();

export function registerSessionAmbientEnv(
  sessionID: string,
  ambient: SessionAmbientEnv,
): () => void {
  ambientBySession.set(sessionID, ambient);
  return () => {
    if (ambientBySession.get(sessionID) === ambient) {
      ambientBySession.delete(sessionID);
    }
  };
}

/**
 * Environment variables every spawned session process must receive, across
 * Claude SDK, Codex CLI and custom-command execution paths. Returns an empty
 * object for an unknown session (e.g. synthetic test invocations).
 */
export function sessionAmbientEnvironment(
  sessionID: string | undefined,
): NodeJS.ProcessEnv {
  if (!sessionID) return {};
  const ambient = ambientBySession.get(sessionID);
  if (!ambient) return {};
  return {
    FOUNDRY_SERVER_URL: ambient.serverURL,
    FOUNDRY_SESSION_TOKEN: ambient.sessionToken,
    FOUNDRY_WORKSPACE_ID: ambient.workspaceID,
  };
}

/**
 * The full environment of a session process: the profile's runtime
 * environment plus the session's identity, attachments and ambient
 * orchestration credentials.
 */
export function sessionEnvironment(
  workspacePath: string,
  profile: AgentProfileLocalConfig,
  session?: AgentSession,
): NodeJS.ProcessEnv {
  return {
    ...baseProcessEnvironment(profile),
    ...profileRuntimeEnvironment(profile, session),
    ...sessionAmbientEnvironment(session?.id),
    FOUNDRY_ATTACHMENTS_JSON: JSON.stringify(session?.attachments ?? []),
    FOUNDRY_AGENT_PROFILE: profileID(profile),
    FOUNDRY_AGENT_PROFILE_LABEL: profile.label ?? profileID(profile),
    FOUNDRY_WORKSPACE: workspacePath,
    FOUNDRY_SESSION_ID: session?.id ?? process.env.FOUNDRY_SESSION_ID ?? "",
    FOUNDRY_SESSION_SOURCE:
      session?.source ?? process.env.FOUNDRY_SESSION_SOURCE ?? "chat",
  };
}

/**
 * The Foundry tools (session orchestration over the server's MCP endpoint)
 * for a session that holds an orchestration identity. Utility sessions such
 * as naming never get them.
 */
export function foundryToolsEndpoint(
  session: AgentSession,
): { url: string; token: string } | undefined {
  if (isUtilitySession(session)) return undefined;
  const ambient = ambientBySession.get(session.id);
  if (!ambient?.sessionToken || !ambient.serverURL) return undefined;
  return {
    url: new URL("/api/mcp", ambient.serverURL).toString(),
    token: ambient.sessionToken,
  };
}
