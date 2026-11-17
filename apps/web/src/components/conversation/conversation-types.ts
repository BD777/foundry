import type { ReactNode, Ref } from "react";
import type {
  AgentBackgroundTask,
  AgentContextCompaction,
  AgentQuestion,
  AgentSessionInputSource,
  AgentTurnUsage,
  ChatAttachment,
  MessageChannelOrigin,
  SessionToolFrame,
} from "@bd777/foundry-protocol";
import type { RuntimeKind } from "../agent-runtime/runtime-mark";
import type { ConversationAnnotation } from "./annotations";
import type { ProcessDisplayItem } from "./chat-process-display";
import type { TurnHandoffView } from "./turn-handoffs";
import type { AgentComposerProps } from "../agent-runtime/agent-composer";
import type { ConversationStoragePrefix } from "./conversation-storage";

export type ConversationComposer =
  | ({ mode: "selectable" } & Required<
      Pick<
        AgentComposerProps,
        "agentOptions" | "agentValue" | "onAgentChange" | "runtimeControls"
      >
    > &
      Pick<
        AgentComposerProps,
        "agentPickerActions" | "agentPickerFooter" | "slashItems"
      >)
  | { mode: "fixed"; runtime: RuntimeKind; model?: string }
  /** No agent shown: the person talks to the assistant, not to a runtime. */
  | { mode: "plain" };

/** The complete conversation contract. Hosts adapt business data and execute commands. */
export interface ConversationProps {
  threadKey: string;
  messages: ChatMessageItem[];
  /** "Only my conversation": turns the person did not start are hidden. */
  onlyMine?: boolean;
  /** Pinned at the top of the composer: what the conversation waits for. */
  attention?: ReactNode;
  /** How many turns the person did not start are hidden now. */
  onHiddenTurnsChange?: (count: number) => void;
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
    options?: {
      idempotencyKey?: string;
      annotations?: ConversationAnnotation[];
    },
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
  /** The workspace folder: paths inside it link only once verified. */
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
  /** Annotations on earlier answers; the text already carries their wrapper. */
  annotations?: ConversationAnnotation[];
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
  /**
   * When a server-kept message enters the running turn (DEV-082): at its
   * next step, or at once; absent, it waits for the turn to end.
   */
  delivery?: "boundary" | "interrupt";
  /** A boundary message goes in at this time without waiting for a step. */
  fallbackAt?: string;
}

/** How a message sent during a turn reaches it; turn_end waits for its end. */
export type ConversationDelivery = "boundary" | "interrupt" | "turn_end";

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
  /**
   * `steer` moves it into the running turn at once, when there is one;
   * `delivery` is when it enters a running turn (DEV-082).
   */
  enqueue: (
    chatId: string,
    message: Pick<QueuedDraft, "id" | "text" | "attachments" | "annotations">,
    options?: { steer?: boolean; delivery?: ConversationDelivery },
  ) => Promise<ConversationQueueOutcome>;
  /** Changes when a waiting message enters the running turn. */
  setDelivery: (
    chatId: string,
    id: string,
    delivery: ConversationDelivery,
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

/** A finished background task a turn followed: its public fields, and the session whose output read names its command. */
export interface ConversationBackgroundTask {
  id: string;
  kind: AgentBackgroundTask["kind"];
  description: string;
  status: AgentBackgroundTask["status"];
  exitCode?: number;
  sessionId: string;
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
  /** A sent message's annotations on earlier answers, shown beside its text. */
  annotations?: ConversationAnnotation[];
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
  /**
   * "waiting": queued work that waits for its offline device, without a
   * timer. "stopped": the turn ended without an answer (stopped or failed),
   * shown as a quiet line (DEV-267).
   */
  kind?:
    | "boundary"
    | "failure"
    | "message"
    | "process"
    | "stopped"
    | "tool"
    | "waiting";
  /** A stopped turn asks for one more attempt: the same retry as Needs you. */
  onRetry?: () => Promise<void>;
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
   * A message channel turn: render its source conversation, sender and
   * messages instead of the raw facts block, which goes behind 「详情」.
   */
  channelOrigin?: MessageChannelOrigin;
  /**
   * The session that sent a message, when another session did: named above
   * it, opened by `onOpen` (absent: the viewer cannot open it).
   */
  sentBy?: { sessionId: string; label: string; onOpen?: () => void };
  /** Who or what started this input's turn, from the server (DEV-246). */
  inputSource?: AgentSessionInputSource;
  /** A user message steered into a running turn, not a turn's input. */
  steered?: boolean;
  /**
   * On a boundary: a turn the agent ran on its own, for a timer it set
   * ("scheduled") or after its background work ended ("background").
   */
  continuation?: "scheduled" | "background";
  /** On a boundary: the timer's prompt or the finished work, for its row. */
  continuationDetail?: string;
  /**
   * On a boundary: the whole prompt the event carried (a timer's or a
   * background task's), shown under the row's expansion (DEV-249).
   */
  continuationBody?: string;
  /** On a boundary: the timer was delivered late (catchUp), and `text` says so. */
  continuationCatchUp?: boolean;
  /** On a boundary: the background tasks whose end the turn followed. */
  backgroundTasks?: ConversationBackgroundTask[];
  streaming?: boolean;
  text: ReactNode;
  title?: ReactNode;
  /** The turn's provider usage, on the answer that ends the turn. */
  usage?: AgentTurnUsage;
  /** Verified paths the answer names; linked once it stops streaming. */
  fileReferences?: ConversationFileReference[];
  /** The files the answer's turn wrote or named, on the answer ending it. */
  turnFiles?: { turnId: string; count: number };
  /**
   * Work this turn handed to other sessions or projects, shown as compact
   * rows after its answer (DEV-250). Absent when it handed nothing off.
   */
  handoffs?: TurnHandoffView[];
  /** Questions the answer asks the person without waiting (Codex). */
  questions?: AgentQuestion[]; /** The native item the questions came in; the answer names it. */
  questionItemId?: string;
  /**
   * "next_turn": the questions ended the turn and wait for the next message
   * (a child session's, also asked of its parent); "async": they never
   * waited (Codex).
   */
  questionDelivery?: "async" | "next_turn";
  /** Where the questions stand, read from the transcript. */
  questionState?: ConversationQuestionState;
  /** The answers given, by question, once answered. */
  questionAnswers?: string[];
  /** On a user message that answers questions: what it answered. */
  questionReply?: { question: string; answer: string }[];
  /** On a boundary: the context compaction it marks (DEV-083). */
  compaction?: AgentContextCompaction;
  /**
   * On a running process row: the tool call running now, which may have
   * started before the rows above it (DEV-089).
   */
  liveActivity?: ConversationLiveActivity;
  /** On a message steered into a running turn: whether the agent read it. */
  steer?: ConversationSteerState;
  /**
   * Stops the tool call the steered message waits behind, so the agent
   * reads it now; offered only where it can be stopped.
   */
  onStopSteerBlocker?: () => Promise<void>;
}

/** A tool call that runs now: its step's label, what it runs, since when. */
export interface ConversationLiveActivity {
  /** The call's id: a row that shows the call itself keeps its own timer. */
  callId?: string;
  title: string;
  detail: string;
  startedAt: string;
  /** The longest the call may run, when its input sets a limit. */
  limitMs?: number;
}

/**
 * How far the agent got with a message steered into its turn. waiting:
 * delivered, read after the tool call it waits behind (`tool`) returns, or
 * at the agent's next step; read: a model request took it in.
 */
export interface ConversationSteerState {
  runtime: Exclude<RuntimeKind, "mock">;
  state: "waiting" | "read";
  deliveredAt: string;
  readAt?: string;
  tool?: { name: string; startedAt: string; limitMs?: number };
  /** Other tool calls it also waits behind. */
  moreTools?: number;
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
 * Claude reports them from model streams; Codex estimates them from native
 * token-usage updates.
 */
export interface StepUsage {
  requests: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  /** End-to-end model-request time, including time to first token. */
  requestMs?: number;
  /** Generation time across the requests; absent unless every request has it. */
  generationMs?: number;
  /** Whether strict generation time looks like genuine streaming on every request. */
  decodeEligible?: boolean;
  /** Whether the request time used for speed was reconstructed. */
  timingEstimated?: boolean;
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
