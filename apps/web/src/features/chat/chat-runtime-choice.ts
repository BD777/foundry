import type { AgentSession } from "@bd777/foundry-protocol";
import {
  readRuntimeChoice,
  writeRuntimeChoice,
} from "../../components/conversation/conversation-storage";
import type { ChatOverrideDraft } from "./chat-types";

/** The agent and runtime overrides a chat's composer is set to. */
export interface ChatRuntimeChoice {
  agentId: string;
  override: ChatOverrideDraft;
}

const overrideFields = [
  "claudeEffort",
  "claudePermissionMode",
  "codexApprovalPolicy",
  "codexReasoningEffort",
  "codexSandboxMode",
  "codexSpeed",
  "model",
] as const satisfies readonly (keyof ChatOverrideDraft)[];

/** String override fields of `source`; empty ones only when `keepEmpty`. */
function pickOverride(source: unknown, keepEmpty: boolean): ChatOverrideDraft {
  const override: Record<string, string> = {};
  if (!source || typeof source !== "object") return override;
  for (const field of overrideFields) {
    const value = (source as Record<string, unknown>)[field];
    if (typeof value === "string" && (keepEmpty || value)) {
      override[field] = value;
    }
  }
  return override as ChatOverrideDraft;
}

export function readChatRuntimeChoice(
  threadKey: string,
): { choice: ChatRuntimeChoice; updatedAt: number } | undefined {
  const stored = readRuntimeChoice(threadKey);
  const value = stored?.value as Partial<ChatRuntimeChoice> | undefined;
  if (!stored || typeof value?.agentId !== "string" || !value.agentId) {
    return undefined;
  }
  return {
    choice: {
      agentId: value.agentId,
      override: pickOverride(value.override, true),
    },
    updatedAt: stored.updatedAt,
  };
}

export function rememberChatRuntimeChoice(
  threadKey: string,
  choice: ChatRuntimeChoice,
): void {
  writeRuntimeChoice(threadKey, choice);
}

/**
 * What an opened chat's composer restores. A choice stored after the chat's
 * latest message survives a reload; otherwise the runtime that session
 * recorded wins, and the stored choice only fills what it did not record.
 * A chat without a session restores its stored choice, else `fallbackAgentId`.
 */
export function restoredChatRuntime({
  fallbackAgentId,
  latest,
  stored,
}: {
  fallbackAgentId?: string;
  latest?: AgentSession;
  stored?: { choice: ChatRuntimeChoice; updatedAt: number };
}): ChatRuntimeChoice | undefined {
  if (!latest) {
    return (
      stored?.choice ??
      (fallbackAgentId ? { agentId: fallbackAgentId, override: {} } : undefined)
    );
  }
  const sentAt = Date.parse(latest.input?.at ?? latest.startedAt ?? "");
  if (stored && Number.isFinite(sentAt) && stored.updatedAt > sentAt) {
    return stored.choice;
  }
  const storedOverride =
    stored?.choice.agentId === latest.agentId ? stored.choice.override : {};
  return {
    agentId: latest.agentId,
    override: { ...storedOverride, ...pickOverride(latest, false) },
  };
}
