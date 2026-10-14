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
  | { mode: "fixed"; runtime: RuntimeKind; model?: string }
  /** No agent shown: the person talks to the assistant, not to a runtime. */
  | { mode: "plain" };

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
  /** A line above the input about work that goes on between turns. */
  notice?: ReactNode;
  /** Above the first message: how the transcript loads, older messages. */
  history?: ReactNode;
  /** The person scrolled to the first message (older ones may load). */
  onReachHistoryStart?: () => void;
  /**
   * Keeps the draft in this browser, per thread; without serverQueue, the
   * queued messages too.
   */
  storageKeyPrefix?: ConversationStoragePrefix;
  /**
   * The server keeps and sends this conversation's queued messages (chats).
   * Without it they stay in this browser, which sends them (Issues).
   */
  serverQueue?: ConversationServerQueue;
  draftResetKey?: number;
  inputRef?: Ref<HTMLTextAreaElement>;
  inputLabel?: string;
  sendLabel?: string;
  /** The button that stops the reply being written; a default names the agent. */
  stopLabel?: string;
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
  /** Injects a queued message, with its files, into the running execution. */
  onSteer?: (
    text: string,
    executionId?: string,
    attachments?: ChatAttachment[],
  ) => Promise<boolean>;
  onStop?: (executionId?: string) => Promise<void> | void;
  onImagePreview?: (image: ParsedImageTag) => void;
  /** Files an answer names and the host can show; see ConversationFileActions. */
  fileActions?: ConversationFileActions;
}

/** A path an answer names that its device verified; linked in the text. */
/** An image a message shows (an `<image>` tag or an attachment), as previewed. */
export interface ParsedImageTag {
  alt: string;
  path: string;
}

export interface ConversationFileReference {
  /** As it appears in the answer: a code span's content or a link target. */
  text: string;
  path: string;
  kind: "file" | "dir";
  /** Named before it existed, and no file is recorded at `path` yet. */
  pending?: boolean;
  /** The session whose answer named a pending file: reads go through it. */
  sessionId?: string;
}

/** What an answer's file links and its "N files" chip do in the host. */
export interface ConversationFileActions {
  open: (reference: ConversationFileReference) => void;
  showTurn: (turnId: string) => void;
}

/**
 * `true` once accepted; "replied" completes a conversational turn without
 * awaiting an execution; "queue" when a turn started meanwhile, so the
 * message waits for it in the queue; `{ threadKey }` when the accepted
 * message gave the conversation a new key (a new chat's session, an adopted
 * native chat).
 */
export type ConversationSendOutcome =
  boolean | "replied" | "queue" | { threadKey: string };

export interface QueuedDraft {
  id: string;
  text: string;
  /** Uploaded before queueing, so these are server references. */
  attachments?: ChatAttachment[];
  targetExecutionId?: string;
  /** Set while a tab sends this message; a stale one may have been sent. */
  sending?: { tab: string; at: number };
  /**
   * Where a server-kept queue has it: still only in this tab (local), or the
   * server's state. Absent in a browser-kept queue.
   */
  state?: "local" | "queued" | "dispatching" | "failed";
  /** Why the server could not send it; it holds the queue. */
  error?: string;
  /**
   * Failed without its device's answer: it may be in the conversation
   * already, so the person checks before retrying it.
   */
  maybeSent?: boolean;
  /** The server's revision of the message, for edits. */
  revision?: number;
}

/** How a change to a server-kept queue went; a refusal leaves the server's queue shown. */
export type ConversationQueueOutcome =
  | { ok: true }
  | { ok: false; reason: "sent" | "changed" | "failed"; message?: string };

/**
 * A queue the server keeps for a conversation. The host applies changes at
 * once and rolls them back when the server refuses them.
 */
export interface ConversationServerQueue {
  /** The server's id of this conversation; undefined until it has one. */
  chatId?: string;
  /** The server's queue of chatId, in sending order; undefined while loading. */
  items?: QueuedDraft[];
  enqueue: (
    chatId: string,
    message: Pick<QueuedDraft, "id" | "text" | "attachments">,
  ) => Promise<ConversationQueueOutcome>;
  edit: (
    chatId: string,
    id: string,
    text: string,
  ) => Promise<ConversationQueueOutcome>;
  remove: (chatId: string, id: string) => Promise<ConversationQueueOutcome>;
  reorder: (chatId: string, ids: string[]) => Promise<ConversationQueueOutcome>;
  steer: (chatId: string, id: string) => Promise<ConversationQueueOutcome>;
  retry: (chatId: string, id: string) => Promise<ConversationQueueOutcome>;
}

export interface ChatMessageItem {
  at?: string;
  /**
   * The client id of a message this tab sent (its Idempotency-Key): the
   * composer lets it go once the transcript shows it.
   */
  clientId?: string;
  agentLabel?: ReactNode;
  attachments?: ChatAttachment[];
  copyAlways?: boolean;
  copyText?: string;
  /** How long a process group ran, from its start to its last step. */
  durationMs?: number;
  /**
   * When a process group began: where the segment before it (the input, a
   * steered message, an answer) ended. Its live timer counts from here.
   */
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
  /** Verified paths the answer names; linked once it stops streaming. */
  fileReferences?: ConversationFileReference[];
  /** The files the answer's turn wrote or named, on the answer ending it. */
  turnFiles?: { turnId: string; count: number };
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
