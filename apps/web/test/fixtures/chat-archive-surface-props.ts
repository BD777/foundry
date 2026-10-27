import type { ChatSurfaceProps } from "../../src/features/chat/chat-surface-types";

/** Minimal real surface, shared by browser and component regressions. */
export function archiveSurfaceProps(
  overrides: Partial<ChatSurfaceProps> = {},
): ChatSurfaceProps {
  const noop = () => {};
  const queued = async () => ({ ok: true as const });
  return {
    workspaceId: "archive-fixture",
    chats: [],
    chatTitle: "Archive fixture",
    messages: [],
    threadKey: "archive-fixture:new",
    agentOptions: [],
    selectedAgentId: "",
    claudeEffort: "",
    claudePermissionMode: "default",
    codexApprovalPolicy: "on-request",
    codexReasoningEffort: "",
    codexSandboxMode: "workspace-write",
    codexSpeed: "standard",
    modelOptions: [],
    modelValue: "",
    onAgentChange: noop,
    onClaudeEffortChange: noop,
    onClaudePermissionModeChange: noop,
    onCodexApprovalPolicyChange: noop,
    onCodexReasoningEffortChange: noop,
    onCodexSandboxModeChange: noop,
    onCodexSpeedChange: noop,
    onModelChange: noop,
    onNewChat: noop,
    onResetControls: noop,
    onSend: async () => false,
    queue: {
      items: [],
      enqueue: queued,
      edit: queued,
      remove: queued,
      reorder: queued,
      steer: queued,
      retry: queued,
    },
    ...overrides,
  };
}
