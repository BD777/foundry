import { useState } from "react";
import type {
  ClaudeEffort,
  CodexReasoningEffort,
  CodexSpeed,
  Issue,
  WorkerRuntimeId,
} from "@bd777/foundry-protocol";
import { createIssue, workspaceNeedsGit } from "../../api";
import type { CreateIssueInput } from "../../api-types";

/** The request for a new Issue from the composer and its model settings. */
export function issueInput(
  runtime: WorkerRuntimeId,
  settings: {
    model?: string;
    speed?: CodexSpeed;
    effort?: ClaudeEffort | CodexReasoningEffort;
    profileId?: string;
  },
  sourceInput: string,
  workspaceId: string,
): CreateIssueInput {
  return {
    runtime,
    model: settings.model || undefined,
    codexSpeed: runtime === "codex" ? settings.speed : undefined,
    profileId: settings.profileId,
    claudeEffort:
      runtime === "claude" ? (settings.effort as ClaudeEffort) : undefined,
    codexReasoningEffort:
      runtime === "codex"
        ? (settings.effort as CodexReasoningEffort)
        : undefined,
    sourceInput,
    workspaceId,
  };
}

/**
 * Creating an Issue, and holding it while the person decides whether to set
 * up Git in a workspace without it. Nothing is created or changed until they
 * confirm; cancelling drops the request.
 */
export function useIssueCreation(onCreated: (issue: Issue) => Promise<void>) {
  const [pending, setPending] = useState<CreateIssueInput>();
  return {
    /** Creates the Issue; false when it waits for the Git confirmation. */
    async create(input: CreateIssueInput): Promise<boolean> {
      try {
        await onCreated(await createIssue(input));
        return true;
      } catch (error) {
        if (!workspaceNeedsGit(error)) throw error;
        setPending(input);
        return false;
      }
    },
    gitSetupPending: pending !== undefined,
    cancelGitSetup: () => setPending(undefined),
    async confirmGitSetup(): Promise<void> {
      if (!pending) return;
      const issue = await createIssue({ ...pending, initializeGit: true });
      setPending(undefined);
      await onCreated(issue);
    },
  };
}
