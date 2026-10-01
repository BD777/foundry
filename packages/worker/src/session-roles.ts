// What a session working for an Issue may do, decided by its role alone
// (docs/architecture-modules.md §6, D3/D5). A chat has no role and runs as
// the person's own terminal agent would. An Issue's clarification talks the
// Issue through with the person: it reads the project, its instructions and
// the workspace's selected skills, and may look up the workspace's sessions,
// but it never writes, runs commands or starts other work.

import type { AgentSession } from "@bd777/foundry-protocol";
import { codexDisabledFeatures } from "./session/policy.js";

/** The Foundry tools a clarification may call: reading other sessions. */
export const clarificationFoundryTools = ["list_sessions", "read_context"];

const clarificationClaudeTools = [
  "Read",
  "Grep",
  "Glob",
  ...clarificationFoundryTools.map((tool) => `mcp__foundry__${tool}`),
];

const clarificationDeniedClaudeTools = [
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Task",
  "Agent",
  "WebFetch",
  "WebSearch",
];

export function isClarificationSession(session: AgentSession): boolean {
  return session.role === "issue_clarification";
}

/**
 * Claude launch options a role overrides. Only the listed tools run; any
 * other request is denied without a prompt, and only the project's own
 * settings and instructions load.
 */
export function claudeRoleOptions(
  session: AgentSession,
): { sdk: Record<string, unknown>; cliArgs: string[] } | undefined {
  if (!isClarificationSession(session)) return undefined;
  return {
    sdk: {
      permissionMode: "dontAsk",
      allowedTools: clarificationClaudeTools,
      disallowedTools: clarificationDeniedClaudeTools,
      settingSources: ["project"],
      strictMcpConfig: true,
    },
    cliArgs: [
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      clarificationClaudeTools.join(","),
      "--disallowedTools",
      clarificationDeniedClaudeTools.join(","),
      "--setting-sources",
      "project",
      "--strict-mcp-config",
    ],
  };
}

/** Codex configuration and thread options a role overrides. */
export function codexRoleOptions(session: AgentSession):
  | {
      config: Record<string, unknown>;
      thread: Record<string, unknown>;
    }
  | undefined {
  if (!isClarificationSession(session)) return undefined;
  return {
    // Its read-only shell stays: Codex reads files through it, inside a
    // read-only sandbox without network.
    config: { features: codexDisabledFeatures(true) },
    thread: {
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
    },
  };
}
