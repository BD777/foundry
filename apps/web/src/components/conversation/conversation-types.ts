import type { ReactNode, Ref } from "react";
import type { ChatAttachment } from "@foundry/protocol";
import type { RuntimeKind } from "../ui/runtime-mark";
import type { ProcessDisplayItem } from "./chat-process-display";
import type { AgentComposerProps } from "../ui/agent-composer";

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
  readOnly?: ReactNode;
  draftStorageKey?: string;
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
  /** "replied" completes a conversational turn without awaiting an execution. */
  onSend: (
    text: string,
    attachments?: ChatAttachment[],
  ) => Promise<boolean | "replied">;
  onSteer?: (text: string, executionId?: string) => Promise<boolean>;
  onStop?: (executionId?: string) => Promise<void> | void;
  onImagePreview?: (
    image: import("./chat-message-content").ParsedImageTag,
  ) => void;
}

export interface QueuedDraft {
  id: string;
  text: string;
  attachments?: ChatAttachment[];
  targetExecutionId?: string;
}

export interface ChatMessageItem {
  at?: string;
  agentLabel?: ReactNode;
  attachments?: ChatAttachment[];
  copyAlways?: boolean;
  copyText?: string;
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
  streaming?: boolean;
  text: ReactNode;
  title?: ReactNode;
}
