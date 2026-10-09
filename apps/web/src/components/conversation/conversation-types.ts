import type { ReactNode, Ref } from "react";
import type { AgentTurnUsage, ChatAttachment } from "@bd777/foundry-protocol";
import type { RuntimeKind } from "../ui/runtime-mark";
import type { ProcessDisplayItem } from "./chat-process-display";
import type { AgentComposerProps } from "../ui/agent-composer";
import type { ConversationStoragePrefix } from "./conversation-storage";

export type ConversationComposer =
  | ({ mode: "selectable" } & Required<
      Pick<
        AgentComposerProps,
        "agentOptions" | "agentValue" | "onAgentChange" | "runtimeControls"
      >
    > &
      Pick<AgentComposerProps, "agentPickerFooter" | "slashItems">)
  | { mode: "fixed"; runtime: RuntimeKind; model?: string };

/** The complete conversation contract. Hosts adapt business data and execute commands. */
export interface ConversationProps {
  threadKey: string;
  messages: ChatMessageItem[];
  composer: ConversationComposer;
  active?: boolean;
  activeExecutionId?: string;
  sending?: boolean;
  disabled?: boolean;
  /** Why sending is unavailable, shown in the composer while it is. */
  disabledReason?: string;
  readOnly?: ReactNode;
  /** Keeps the draft and queued messages in this browser, per thread. */
  storageKeyPrefix?: ConversationStoragePrefix;
  draftResetKey?: number;
  inputRef?: Ref<HTMLTextAreaElement>;
  inputLabel?: string;
  sendLabel?: string;
  placeholder?: string;
  attachments?: ChatAttachment[];
  attachmentUploading?: boolean;
  onAttachmentsAdd?: (files: File[]) => void;
  onAttachmentRemove?: (id: string) => void;
  onAttachmentsRestore?: (attachments: ChatAttachment[]) => void;
  /** Read-only side questions may reply without queueing another execution. */
  canSendDuringExecution?: (text: string) => boolean;
  /**
   * A queued message passes its id as the idempotency key, so a request
   * repeated after a reload or from another tab can be recognized.
   */
  onSend: (
    text: string,
    attachments?: ChatAttachment[],
    options?: { idempotencyKey?: string },
  ) => Promise<ConversationSendOutcome>;
  onSteer?: (text: string, executionId?: string) => Promise<boolean>;
  onStop?: (executionId?: string) => Promise<void> | void;
  onImagePreview?: (
    image: import("./chat-message-content").ParsedImageTag,
  ) => void;
}

/**
 * `true` once accepted; "replied" completes a conversational turn without
 * awaiting an execution; `{ threadKey }` when the accepted message gave the
 * conversation a new key (a new chat's session, an adopted native chat).
 */
export type ConversationSendOutcome =
  boolean | "replied" | { threadKey: string };

export interface QueuedDraft {
  id: string;
  text: string;
  /** Uploaded before queueing, so these are server references. */
  attachments?: ChatAttachment[];
  targetExecutionId?: string;
  /** Set while a tab sends this message; a stale one may have been sent. */
  sending?: { tab: string; at: number };
}

export interface ChatMessageItem {
  at?: string;
  agentLabel?: ReactNode;
  attachments?: ChatAttachment[];
  copyAlways?: boolean;
  copyText?: string;
  /** How long a process group ran, from its first to its last step. */
  durationMs?: number;
  /** When a process group's first step happened, for its live timer. */
  startedAt?: string;
  /** Tokens of the model requests behind a process group's steps. */
  stepUsage?: StepUsage;
  editable?: boolean;
  editText?: string;
  id: string;
  idea?: string;
  kind?: "boundary" | "failure" | "message" | "process" | "tool";
  processItems?: ProcessDisplayItem[];
  onTurnIntoIssue?: () => void;
  recoverable?: boolean;
  role: "user" | "bot";
  runtime?: Exclude<RuntimeKind, "mock">;
  statusLabel?: ReactNode;
  /** Where the message came from, shown beside its time (e.g. "via Feishu"). */
  origin?: ReactNode;
  streaming?: boolean;
  text: ReactNode;
  title?: ReactNode;
  /** The turn's provider usage, on the answer that ends the turn. */
  usage?: AgentTurnUsage;
}

/**
 * Tokens of the model requests behind some steps, each request counted once.
 * Claude reports them per request; Codex only per turn, so its steps have none.
 */
export interface StepUsage {
  requests: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}
