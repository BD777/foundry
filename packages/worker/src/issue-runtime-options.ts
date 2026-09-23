import type { AgentSession, Issue } from "@foundry/protocol";

/** Autonomous Issue execution still runs inside Foundry's candidate sandbox. */
export function issueRuntimeOptions(
  issue: Issue,
): Pick<
  AgentSession,
  | "model"
  | "codexSpeed"
  | "profileId"
  | "claudeEffort"
  | "codexReasoningEffort"
  | "claudePermissionMode"
  | "codexApprovalPolicy"
  | "codexSandboxMode"
> {
  return {
    model: issue.model,
    codexSpeed: issue.runtime === "codex" ? issue.codexSpeed : undefined,
    profileId: issue.profileId,
    claudeEffort: issue.runtime === "claude" ? issue.claudeEffort : undefined,
    codexReasoningEffort:
      issue.runtime === "codex" ? issue.codexReasoningEffort : undefined,
    claudePermissionMode: "bypassPermissions",
    codexApprovalPolicy: "never",
    codexSandboxMode: "danger-full-access",
  };
}
