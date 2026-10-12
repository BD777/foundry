// What a session working for an Issue may do, decided by its role alone
// (docs/architecture-modules.md §6, D3/D5). A chat has no role and runs as
// the person's own terminal agent would. An Issue's clarification talks the
// Issue through with the person: it reads the project, its instructions and
// the workspace's selected skills, and may look up the workspace's sessions,
// but it never writes, runs commands or starts other work. A verifier (a
// session started with verification) checks another session's work: it
// runs inside a sandbox that keeps the workspace read-only for it and every
// command it runs (verification-session.ts), and its Foundry tools only read.

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

export function isVerificationSession(session: AgentSession): boolean {
  return session.source === "verification";
}

/**
 * A verifier's tools: Claude Code's own, which its sandbox keeps from
 * changing the workspace (writes land only in its scratch directory), its
 * skills, and the Foundry tools, of which the server lists it only those
 * that change nothing.
 */
const verificationClaudeTools = [
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Task",
  "Agent",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Skill",
  "mcp__foundry",
];

/**
 * Claude launch options a role overrides. Only the listed tools run; any
 * other request is denied without a prompt, and only the project's own
 * settings and instructions load.
 */
export function claudeRoleOptions(
  session: AgentSession,
): { sdk: Record<string, unknown> } | undefined {
  if (isVerificationSession(session))
    return {
      sdk: {
        permissionMode: "dontAsk",
        allowedTools: verificationClaudeTools,
        settingSources: ["project"],
        strictMcpConfig: true,
      },
    };
  if (!isClarificationSession(session)) return undefined;
  return {
    sdk: {
      permissionMode: "dontAsk",
      allowedTools: clarificationClaudeTools,
      disallowedTools: clarificationDeniedClaudeTools,
      settingSources: ["project"],
      strictMcpConfig: true,
    },
  };
}

/** Codex configuration and thread options a role overrides. */
export function codexRoleOptions(session: AgentSession):
  | {
      config: Record<string, unknown>;
      thread: Record<string, unknown>;
    }
  | undefined {
  if (isVerificationSession(session))
    return {
      // The verifier's own sandbox (verification-session.ts) keeps the
      // workspace read-only and lets commands write only its scratch
      // directory. Codex's sandbox cannot run inside it: its
      // workspace-write mode mounts over the workspace's .git, .agents and
      // .codex, which needs directories it cannot create there, and macOS
      // does not nest sandboxes. So Codex runs its commands unsandboxed,
      // as in an Issue's execution, and the verifier's sandbox decides.
      config: { features: codexDisabledFeatures(true) },
      thread: {
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
        webSearchMode: "disabled",
      },
    };
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
