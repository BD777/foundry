// Chats: threads, transcripts, layout, titles and queued messages.
import type { ChatAttachment } from "./contract.gen.js";
export type {
  AgentQuestion,
  ChatArchive,
  ChatAttachment,
  ChatRecapMessage,
  ChatThread,
  NativeArchiveItem,
  NativeArchiveTarget,
  TranscriptMessage,
} from "./contract.gen.js";

export interface ChatLayoutGroup {
  archivedAt?: string;
  archiveBatchId?: string;
  id: string;
  name: string;
}

export interface ChatPlacement {
  chatId: string;
  groupId: string;
}

/** A chat's title as GET /api/chat-titles lists it. */
export interface ChatTitle {
  chatId: string;
  title: string;
  version: string;
  generationSessionId?: string;
  generationStatus?: string;
  generationError?: string;
}

// Array order defines group order and the order of chats within each container.
// An empty groupId denotes the ungrouped list.
export interface ChatLayout {
  revision: number;
  groups: ChatLayoutGroup[];
  positions: ChatPlacement[];
}

/** The composer's choices when a message was queued; it is sent with them. */
export interface ChatQueueRunSettings {
  agentId?: string;
  provider?: string;
  profileId?: string;
  model?: string;
  claudeEffort?: string;
  claudePermissionMode?: string;
  codexReasoningEffort?: string;
  codexSandboxMode?: string;
  codexApprovalPolicy?: string;
  codexSpeed?: string;
  profileTransitionNote?: string;
}

export type ChatQueueItemState = "queued" | "dispatching" | "sent" | "failed";

/**
 * A message queued in a chat. The server sends it as the chat's next input
 * once the chat's session is idle; a failed one holds the queue.
 */
export interface ChatQueueItem {
  id: string;
  chatId: string;
  position: number;
  text: string;
  attachments?: ChatAttachment[];
  runSettings: ChatQueueRunSettings;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  state: ChatQueueItemState;
  error?: string;
  sentSessionId?: string;
  /**
   * A failed message its device may have taken after all (it did not answer
   * in time); the person checks the chat before retrying it.
   */
  maybeSent?: boolean;
  /**
   * When the message enters a running turn (DEV-082): boundary at the
   * turn's next step, interrupt at once; absent, as the next turn's input.
   * The server holds it until then, so it can still be changed or withdrawn.
   */
  delivery?: ChatQueueDelivery;
  /** When the person chose that delivery. */
  deliverySince?: string;
  /** A boundary message goes in at this time without waiting for a step. */
  fallbackAt?: string;
}

/** When a person's message enters a running turn. */
export type ChatQueueDelivery = "boundary" | "interrupt";

/** How a person sends a message during a turn; turn_end waits for its end. */
export type ChatMessageDelivery = ChatQueueDelivery | "turn_end";

/** A chat's unsent messages in sending order; revision grows with each change. */
export interface ChatQueue {
  workspaceId: string;
  chatId: string;
  revision: number;
  items: ChatQueueItem[];
}

export interface EnqueueChatMessageInput {
  text: string;
  attachments?: ChatAttachment[];
  runSettings: ChatQueueRunSettings;
  /**
   * Into the chat's running turn at once (an answer to the Agent's
   * question); with nothing running it waits like any queued message.
   */
  steer?: boolean;
  /** When it enters a running turn (ChatQueueItem.delivery). */
  delivery?: ChatMessageDelivery;
}

export interface EditChatQueueItemInput {
  text?: string;
  attachments?: ChatAttachment[];
  runSettings?: ChatQueueRunSettings;
  delivery?: ChatMessageDelivery;
  expectedRevision: number;
}

export interface ReorderChatQueueInput {
  itemIds: string[];
  expectedRevision: number;
}
export interface ArchiveChatsInput {
  expectedChatIds?: string[];
  workspaceId: string;
  chatIds?: string[];
  groupId?: string;
  batchId?: string;
  dryRun?: boolean;
}
export interface ArchiveHiddenChat {
  id: string;
  title: string;
}
export interface ArchiveBlocker {
  action?: string;
  workId?: string;
  workSessionId?: string;
  workRevision?: number;
  workReferenceRevision?: number;
  code?: string;
  issueId?: string;
  workTitle?: string;
  id: string;
  reason: string;
}
export interface ArchivePausedWork {
  id: string;
  title: string;
  sessionId: string;
}
export interface ArchiveChatsResult {
  nativeAlsoHidden?: ArchiveHiddenChat[];
  batchId: string;
  archived: string[];
  blockers: ArchiveBlocker[];
  pausedWork: ArchivePausedWork[];
}
