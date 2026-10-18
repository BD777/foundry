import type { ChatThread, DeviceProjection } from "@bd777/foundry-protocol";
import {
  chatMessageItemId,
  chatMessages,
  chatMessagesForThread,
  latestCopyableResponseIndex,
} from "./chat-model";
import {
  withOutbox,
  type OutboxEntry,
  type OutboxProjection,
} from "./chat-outbox";
import type { ChatMessageItem } from "./chat-surface-types";
import type { ChatSessionThread, ChatViewMessage } from "./chat-types";

/** The transcript the chat shows: its sessions' or stored messages, plus the outbox. */
export function chatViewMessages({
  chat,
  devices,
  outbox,
  suppressedResponseFingerprints,
  thread,
}: {
  chat?: ChatThread;
  /** Names the offline device a queued session waits for. */
  devices?: readonly DeviceProjection[];
  outbox: readonly OutboxEntry[];
  suppressedResponseFingerprints: ReadonlySet<string>;
  thread?: ChatSessionThread;
}): OutboxProjection {
  return withOutbox(
    thread
      ? chatMessagesForThread(thread, {
          devices,
          suppressedResponseFingerprints,
        })
      : chatMessages(chat),
    outbox,
    thread?.id,
  );
}

function isPlainMessage(message: ChatViewMessage): boolean {
  return (
    typeof message.text === "string" &&
    (message.kind === undefined || message.kind === "message") &&
    message.text.trim() !== ""
  );
}

function latestEditableUserIndex(messages: ChatViewMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === "user" && isPlainMessage(message)) {
      return index;
    }
  }
  return -1;
}

/**
 * The transcript rows with their actions: copy, edit of the latest user
 * message while no agent is responding, and turning an idea into an Issue.
 * `senderOf` names the session that sent a message another session sent.
 */
export function chatMessageItems(
  messages: ChatViewMessage[],
  {
    agentActive,
    onTurnIntoIssue,
    senderOf,
  }: {
    agentActive: boolean;
    onTurnIntoIssue: (source: string) => void;
    senderOf?: (sessionId: string) => ChatMessageItem["sentBy"];
  },
): ChatMessageItem[] {
  const latestResponseIndex = latestCopyableResponseIndex(messages);
  const editableIndex = agentActive ? -1 : latestEditableUserIndex(messages);
  return messages.map((message, index) => ({
    ...message,
    copyAlways: index === latestResponseIndex,
    copyText: isPlainMessage(message) ? message.text : undefined,
    editable: index === editableIndex,
    editText: index === editableIndex ? message.text : undefined,
    id: chatMessageItemId(message, index),
    onTurnIntoIssue: message.idea
      ? () => onTurnIntoIssue(message.idea ?? "")
      : undefined,
    sentBy:
      message.role === "user" && message.sentBySessionId
        ? senderOf?.(message.sentBySessionId)
        : undefined,
  }));
}
