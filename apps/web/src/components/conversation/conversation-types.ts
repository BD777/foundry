import type { ReactNode, Ref } from "react";
import type {
  AgentQuestion,
  AgentTurnUsage,
  ChatAttachment,
  SessionToolFrame,
} from "@bd777/foundry-protocol";
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
  /** Read from here instead of by path (a session's frame). */
  source?: string;
}

/** A screenshot a tool step produced, with the session it is read through. */
export type ConversationToolFrame = SessionToolFrame & { sessionId: string };

export interface ConversationFileReference {
  /** As it appears in the answer: a code span's content or a link target. */
  text: string;
  path: string;
  kind: "file" | "dir";
  /** Named before it existed, and no file is recorded at `path` yet. */
  pending?: boolean;
  /** The session whose answer named a pending file: reads go through it. */
  sessionId?: string;
  /**
   * Named inside the workspace but not checked by the device: no request is
   * made until it is opened, and `kind` is guessed from its shape.
   */
  unverified?: true;
  /**
   * A file of the device outside the workspace (`path` as named, absolute
   * or `~/…`), linked for the device's owner only.
   */
  device?: true;
}

/** What an answer's file links and its "N files" chip do in the host. */
export interface ConversationFileActions {
  open: (reference: ConversationFileReference) => void;
  /** The workspace folder: other paths an answer names inside it link too. */
  root?: string;
  /** The viewer owns the device and may open its files outside workspaces. */
  deviceFiles?: boolean;
  showTurn: (turnId: string) => void;
  /** Opens the screen panel on a tool step's frame (DEV-075). */
  openScreen?: (frame: ConversationToolFrame) => void;
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
  /** `steer` moves it into the running turn at once, when there is one. */
  enqueue: (
    chatId: string,
    message: Pick<QueuedDraft, "id" | "text" | "attachments">,
    options?: { steer?: boolean },
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
  /** "waiting": queued work that waits for its offline device, without a timer. */
  kind?: "boundary" | "failure" | "message" | "process" | "tool" | "waiting";
  processItems?: ProcessDisplayItem[];
  onTurnIntoIssue?: () => void;
  recoverable?: boolean;
  failureDiagnostic?: FailureDiagnostic;
  role: "user" | "bot";
  runtime?: Exclude<RuntimeKind, "mock">;
  statusLabel?: ReactNode;
  /** Where the message came from, shown beside its time (e.g. "via Feishu"). */
  origin?: ReactNode;
  /**
   * The session that sent a message, when another session did: named above
   * it, opened by `onOpen` (absent: the viewer cannot open it).
   */
  sentBy?: { sessionId: string; label: string; onOpen?: () => void };
  streaming?: boolean;
  text: ReactNode;
  title?: ReactNode;
  /** The turn's provider usage, on the answer that ends the turn. */
  usage?: AgentTurnUsage;
  /** Verified paths the answer names; linked once it stops streaming. */
  fileReferences?: ConversationFileReference[];
  /** The files the answer's turn wrote or named, on the answer ending it. */
  turnFiles?: { turnId: string; count: number };
  /** Questions the answer asks the person without waiting (Codex). */
  questions?: AgentQuestion[];
  /** The native item the questions came in; the answer names it. */
  questionItemId?: string;
  /** Where the questions stand, read from the transcript. */
  questionState?: ConversationQuestionState;
  /** The answers given, by question, once answered. */
  questionAnswers?: string[];
  /** On a user message that answers questions: what it answered. */
  questionReply?: { question: string; answer: string }[];
}

/**
 * waiting: the turn runs and nothing else was said; answered: a reply came;
 * assumed: the turn ended without one (the Agent went on with its own
 * assumption); unanswered: the person said something else instead.
 */
export type ConversationQuestionState =
  "waiting" | "answered" | "assumed" | "unanswered";

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

/** Localized failure presentation; no classification rules in the renderer. */
export interface FailureDiagnostic {
  /** Where it failed; absent when the error does not say. */
  location?: string;
  guidance: string;
  observation?: string;
  /** The original error when the message replaces it; else the row's own. */
  details?: string;
}
