// Chats: threads, transcripts, layout, titles and queued messages.

import type { RunStatus } from "./issue.js";
import type { WorkerRuntimeId } from "./profiles.js";
import type { AgentTurnUsage, ModelRequestUsage } from "./session.js";

export interface ChatAttachment {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
}

export interface ChatRecapMessage {
  role: "user" | "assistant";
  text: string;
}

/** Display records retain native semantics independently of handoff prose. */
export interface TranscriptMessage {
  id: string;
  at?: string;
  kind:
    | "user"
    | "assistant"
    | "reasoning"
    | "commentary"
    | "tool"
    | "context"
    | "boundary"
    | "status"
    | "failure";
  text: string;
  title?: string;
  callId?: string;
  status?: "running" | "completed" | "failed";
  /** Files that travelled with a user message. */
  attachments?: ChatAttachment[];
  /** Tokens of the model request that produced this step (Claude). */
  requestUsage?: ModelRequestUsage;
  /** On the answer that ended a turn: the turn's usage, read from the agent's own log. */
  turnUsage?: AgentTurnUsage;
}

export interface ChatLayoutGroup {
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
}

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
}

export interface EditChatQueueItemInput {
  text?: string;
  attachments?: ChatAttachment[];
  runSettings?: ChatQueueRunSettings;
  expectedRevision: number;
}

export interface ReorderChatQueueInput {
  itemIds: string[];
  expectedRevision: number;
}

export interface ChatThread {
  id: string;
  updatedAt?: string;
  workspaceId?: string;
  provider?: Exclude<WorkerRuntimeId, "mock">;
  profileId?: string;
  profileFingerprint?: string;
  profileLabel?: string;
  nativeSessionId?: string;
  title: string;
  preview: string;
  handoffContext?: string;
  transcript?: TranscriptMessage[];
  /**
   * Byte offset in the native log where `transcript` starts when it holds
   * only the latest part; what comes before is read from the device a page
   * at a time (read_native_history). Absent when it starts at the log's start.
   */
  transcriptBefore?: number;
  answerRevision?: string;
  recentMessages?: ChatRecapMessage[];
  status?: RunStatus;
  readonly: boolean;
  /** Legacy; lists label `updatedAt` themselves, workers no longer send it. */
  updatedLabel?: string;
}
