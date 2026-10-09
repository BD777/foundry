import type { ReactNode } from "react";
import type {
  AgentModelOption,
  ChatAttachment,
  ClaudeEffort,
  ClaudePermissionMode,
  CodexApprovalPolicy,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexSpeed,
} from "@bd777/foundry-protocol";
import type { RuntimeKind } from "../../components/ui/runtime-mark";
import type { SlashSuggestion } from "../../components/ui/slash-menu";
import type { ChatContextCardData } from "./chat-types";
import type { ChatListStatus } from "./chat-list-state";
import type { ProcessDisplayItem } from "./chat-process-display";
import type { ChatUpdateTime } from "./chat-time";

export interface ChatListItem {
  id: string;
  /** Last conversation activity, from the server; the list orders by it. */
  activityAt?: string;
  updateTime?: ChatUpdateTime;
  onSelect: () => void;
  runtime?: Exclude<RuntimeKind, "mock">;
  selected?: boolean;
  title: string;
  status: ChatListStatus;
  blocked?: boolean;
  blockedReason?: string;
  spawned?: boolean;
  unread: boolean;
  foundrySessionId: string;
  nativeSessionId?: string;
  renaming?: boolean;
  onRename: (title: string) => Promise<void>;
  onAutoRename: () => Promise<void>;
  onMarkUnread: () => void;
  onNotify: (message: string) => void;
}

export type { ChatMessageItem } from "../../components/conversation/conversation-types";
import type {
  ChatMessageItem,
  ConversationProps,
} from "../../components/conversation/conversation-types";

export interface ChatAgentOption {
  disabled?: boolean;
  /** Short reason shown under the label inside the open menu. */
  detail?: string;
  /** Device the agent runs on, used for the device-settings entry. */
  deviceId?: string;
  label: string;
  runtime: Exclude<RuntimeKind, "mock">;
  /** Full technical text exposed as the row's native tooltip. */
  title?: string;
  value: string;
}

export interface ChatSurfaceProps {
  onChatsDeleted?: (chatIds: string[]) => Promise<void>;
  workspaceId: string;
  /** Why the caller may only read this workspace's chats. */
  readOnlyReason?: string;
  agentActive?: boolean;
  agentActiveSessionId?: string;
  agentOptions: ChatAgentOption[];
  attachmentUploading?: boolean;
  attachments?: ChatAttachment[];
  chats: ChatListItem[];
  chatTitle: ReactNode;
  contextCard?: ChatContextCardData;
  claudeEffort: ClaudeEffort | "";
  claudePermissionMode: ClaudePermissionMode;
  codexApprovalPolicy: CodexApprovalPolicy;
  codexReasoningEffort: CodexReasoningEffort | "";
  codexSandboxMode: CodexSandboxMode;
  codexSpeed: CodexSpeed;
  modelLoadFailed?: boolean;
  modelLoading?: boolean;
  modelOptions: AgentModelOption[];
  modelValue: string;
  messages: ChatMessageItem[];
  /** Skills offered by the composer "/skill" menu (workspace selection). */
  slashSkills?: SlashSuggestion[];
  onAgentChange: (value: string) => void;
  onAttachmentsAdd?: (files: File[]) => void;
  onAttachmentRemove?: (id: string) => void;
  onAttachmentsRestore?: (attachments: ChatAttachment[]) => void;
  onCancelActive?: (sessionId?: string) => Promise<void> | void;
  onClaudeEffortChange: (value: ClaudeEffort | "") => void;
  onClaudePermissionModeChange: (value: ClaudePermissionMode) => void;
  onCodexApprovalPolicyChange: (value: CodexApprovalPolicy) => void;
  onCodexReasoningEffortChange: (value: CodexReasoningEffort | "") => void;
  onCodexSandboxModeChange: (value: CodexSandboxMode) => void;
  onCodexSpeedChange: (value: CodexSpeed) => void;
  onModelChange: (value: string) => void;
  onNewChat: () => void;
  onResetControls: () => void;
  onRetryModels?: () => void;
  onSend: ConversationProps["onSend"];
  onSteer?: (value: string, sessionId?: string) => Promise<boolean>;
  selectedAgentId: string;
  sendDisabled?: boolean;
  sendDisabledReason?: string;
  sending?: boolean;
  threadKey: string;
}
