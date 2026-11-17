// How a session with `workspaceAccess: "read"` runs (a message channel's
// session, DEV-203): an ordinary chat of its role, in its workspace, inside
// the verifier's sandbox (verification-session.ts), so the workspace is
// read-only for its agent and every command it runs. Its runtime's records
// and its temporary directory live in a private directory beside the
// workspace's other execution state.

import { resolve } from "node:path";
import type { AgentSession } from "@bd777/foundry-protocol";
import {
  ExecutionStore,
  identifier,
} from "../candidate-store/execution-storage.js";
import { withSessionConnectors } from "../connectors/index.js";
import { sandboxReady } from "../sandbox/index.js";
import { withManagedTools } from "../skills/managed-tools.js";
import { sessionToolsFolder } from "../skills/session-tools.js";
import type { SessionAmbientEnv } from "./session-ambient.js";
import type { WorkspaceSandbox } from "./index.js";
import {
  readOnlyWorkspaceExecution,
  writableWorkspaceExecution,
} from "./verification-session.js";

/** Where a read-only workspace session keeps its private state. */
export function readOnlySessionDirectory(
  workspaceId: string,
  sessionId: string,
  store = new ExecutionStore(),
): string {
  return resolve(
    store.executionRoot,
    identifier(workspaceId),
    "read-only-sessions",
    identifier(sessionId),
  );
}

/**
 * The home its processes have: the private scratch its sandbox lets it
 * write, kept across turns (verification-session.ts).
 */
export function readOnlySessionHome(
  workspaceId: string,
  sessionId: string,
  store = new ExecutionStore(),
): string {
  return resolve(
    readOnlySessionDirectory(workspaceId, sessionId, store),
    "scratch",
  );
}

/**
 * Where and how a read-only workspace session's turn runs. Without a ready
 * sandbox the turn fails: it never runs unsandboxed.
 */
export function readOnlySessionExecution(
  session: AgentSession,
  workspacePath: string,
  ambient: SessionAmbientEnv,
  store = new ExecutionStore(),
  ready = sandboxReady("readonly_agent"),
): { cwd: string; stateRoot: string; sandbox: WorkspaceSandbox } {
  if (!ready)
    throw new Error(
      "This session's workspace is read-only, and this device cannot sandbox it (on Linux it needs bubblewrap with user namespaces); the message was not run.",
    );
  return readOnlyWorkspaceExecution(
    readOnlySessionDirectory(session.workspaceId, session.id, store),
    workspacePath,
    ambient,
    "read-only-session.sb",
    // The agent process runs apart from the worker, which holds the
    // session's connectors and pinned tools: hand them over as its
    // environment.
    (env) => {
      const withConnectors = withSessionConnectors(env, session.id);
      return {
        ...withConnectors,
        PATH: withManagedTools(
          withConnectors.PATH,
          sessionToolsFolder(session.id),
        ),
      };
    },
    // It works on other people's messages: the person's own files (their
    // CLI logins, ~/.ssh, browser data) stay out of its reach. Its tools
    // and connectors come from Foundry's folders and its scratch home.
    "hidden",
  );
}

/**
 * How a writable session in a message channel's lineage runs (DEV-265): its
 * workspace stays writable, but the person's own files stay hidden, so a
 * helper cannot read the credentials the channel's tool holds. Without a
 * ready sandbox the turn fails, as a read-only session does.
 */
export function channelLineageSessionExecution(
  session: AgentSession,
  workspacePath: string,
  ambient: SessionAmbientEnv,
  store = new ExecutionStore(),
  ready = sandboxReady("writable_tree"),
): { cwd: string; stateRoot: string; sandbox: WorkspaceSandbox } {
  if (!ready)
    throw new Error(
      "This session works for a message channel, and this device cannot sandbox its files (on Linux it needs bubblewrap with user namespaces); the message was not run.",
    );
  return writableWorkspaceExecution(
    readOnlySessionDirectory(session.workspaceId, session.id, store),
    workspacePath,
    ambient,
    "channel-lineage-session.sb",
    (env) => {
      const withConnectors = withSessionConnectors(env, session.id);
      return {
        ...withConnectors,
        PATH: withManagedTools(
          withConnectors.PATH,
          sessionToolsFolder(session.id),
        ),
      };
    },
    "hidden",
  );
}
