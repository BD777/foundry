import type { ToastTone } from "../../components/ui/toast";
import type { SelectMenuAction } from "../../components/ui/select-menu";
import type { AccountUsageTarget } from "./chat-account-usage-model";
import type { ReactNode } from "react";
import type {
  AgentModelOption,
  AgentSessionSchedule,
  ChatAttachment,
  ClaudeEffort,
  ClaudePermissionMode,
  ClaudeTimerWake,
  CodexApprovalPolicy,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexSpeed,
} from "@bd777/foundry-protocol";
import type { RuntimeKind } from "../../components/ui/runtime-mark";
import type { SlashSuggestion } from "../../components/ui/slash-menu";
import type {
  ChatContextCardData,
  ChatRunningBackgroundWork,
} from "./chat-types";
import type { ChatListStatus } from "./chat-list-state";
import type { ChatTimerFire } from "./chat-types";
import type { ChatUpdateTime } from "./chat-time";

export interface ChatListItem {
  id: string;
  archiveBlocked?: boolean;
  issueOwned?: boolean;
  /** Last conversation activity, from the server; the list orders by it. */
  activityAt?: string;
  updateTime?: ChatUpdateTime;
  onSelect: () => void;
  runtime?: Exclude<RuntimeKind, "mock">;
  selected?: boolean;
  title: string;
  status: ChatListStatus;
  /** Its agent holds timers that will wake the idle chat. */
  scheduled?: boolean;
  blocked?: boolean;
  blockedReason?: string;
  /** Status "waiting": the offline device its queued work waits for. */
  waitingFor?: string;
  /** Who started it, when another session did: "Started by <title>". */
  startedBy?: string;
  unread: boolean;
  /** Open pending items of the chat (DEV-079), shown as a count. */
  pendingCount?: number;
  foundrySessionId: string;
  nativeSessionId?: string;
  renaming?: boolean;
  onRename: (title: string) => Promise<void>;
  onAutoRename: () => Promise<void>;
  onMarkUnread: () => void;
  onNotify: (message: string, tone?: ToastTone) => void;
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
  /** Short source line under the label, e.g. "Workspace default". */
  meta?: string;
  value: string;
}

/**
 * Why the selected chat takes no message here, shown in place of the
 * composer, with where to go instead.
 */
export interface ChatThreadNotice {
  title: string;
  message: string;
  tone?: "info" | "warning";
  /** `showsList`: on a narrow screen the action shows the chat list. */
  action?: { label: string; onSelect: () => void; showsList?: boolean };
}

export interface ChatSurfaceProps {
  archiveCount?: number;
  onArchive?: (input: {
    chatIds?: string[];
    groupId?: string;
    expectedChatIds?: string[];
    selectionAfterArchive?: string;
  }) => Promise<void>;
  archiveBanner?: ReactNode;
  archiveToast?: {
    id?: string;
    count: number;
    busy: boolean;
    onUndo: () => Promise<void>;
  };
  onChatsDeleted?: (chatIds: string[]) => Promise<void>;
  workspaceId: string;
  /** Why the caller may only read this workspace's chats. */
  readOnlyReason?: string;
  /** Why the selected chat alone cannot be continued here (see ChatThreadNotice). */
  threadNotice?: ChatThreadNotice;
  /**
   * The chat selected, as the address names it: on a narrow screen a chat
   * opened (by a link, from another view) shows its thread, not the list.
   */
  selectedChatId?: string;
  agentActive?: boolean;
  agentActiveSessionId?: string;
  agentOptions: ChatAgentOption[];
  /** Picker rows that act instead of selecting (connection setup, …). */
  agentPickerActions?: SelectMenuAction[];
  attachmentUploading?: boolean;
  attachments?: ChatAttachment[];
  chats: ChatListItem[];
  chatTitle: ReactNode;
  /** Open pending items per chat (DEV-079), from the shell. */
  pendingCounts?: Readonly<Record<string, number>>;
  /** Shown in the open chat's header, before the panel toggle. */
  threadHeaderAction?: ReactNode;
  accountUsage?: AccountUsageTarget;
  usageCompletion?: string;
  contextCard?: ChatContextCardData;
  /** The side panel (the context card) is on screen, or no longer is. */
  onContextPanelVisibleChange?: (visible: boolean) => void;
  /** Set when refreshing the subagents failed: the panel offers a retry. */
  onRetrySubagents?: () => void;
  /** Above the first message: how the transcript loads, older messages. */
  history?: ReactNode;
  /** The person scrolled to the first message. */
  onReachHistoryStart?: () => void;
  /**
   * Background work still running while no turn is: the chat is idle, yet
   * its agent's commands or subagents keep working.
   */
  backgroundWork?: ChatRunningBackgroundWork;
  /** Timers the agent holds: the idle chat wakes when the next is due. */
  schedule?: AgentSessionSchedule;
  /** What the schedule's session says of its timers' last wakes. */
  scheduleWakes?: {
    busy: boolean;
    wakes: ReadonlyMap<string, ClaudeTimerWake>;
    /** The timers' last ended run, when it failed. */
    failedRun?: ChatTimerFire;
  };
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
  /**
   * The workspace's device is offline: what is sent waits for it. With
   * `waitingSessionId`, the open chat's session already waits and may be
   * cancelled.
   */
  offlineDevice?: { label: string; waitingSessionId?: string };
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
  onSteer?: ConversationProps["onSteer"];
  /** The selected chat's queued messages, kept and sent by the server. */
  queue: NonNullable<ConversationProps["serverQueue"]>;
  selectedAgentId: string;
  sendDisabled?: boolean;
  sendDisabledReason?: string;
  sending?: boolean;
  threadKey: string;
}
