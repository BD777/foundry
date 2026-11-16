import type {
  AgentSession,
  ChatThread,
  DeviceProjection,
} from "@bd777/foundry-protocol";
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
} from "../composer/chat-outbox";
import type { ChatMessageItem } from "../chat-surface-types";
import type { ChatSessionThread, ChatViewMessage } from "../chat-types";
import {
  viewHandoff,
  type TurnHandoff,
  type TurnHandoffView,
} from "../../../components/conversation/turn-handoffs";

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
 * `stopTask` stops the tool call a steered message waits behind (DEV-089);
 * absent, the person may not.
 */
export function chatMessageItems(
  messages: ChatViewMessage[],
  {
    agentActive,
    handoffOf,
    onTurnIntoIssue,
    senderOf,
    stopTask,
  }: {
    agentActive: boolean;
    /** Names and links a handoff's session, project or list item (DEV-250). */
    handoffOf?: (handoff: TurnHandoff) => TurnHandoffView;
    /** Absent: an idea is not offered as an Issue. */
    onTurnIntoIssue?: (source: string) => void;
    senderOf?: (sessionId: string) => ChatMessageItem["sentBy"];
    stopTask?: (sessionId: string, taskId: string) => Promise<void>;
  },
): ChatMessageItem[] {
  const latestResponseIndex = latestCopyableResponseIndex(messages);
  const editableIndex = agentActive ? -1 : latestEditableUserIndex(messages);
  return messages.map((message, index) => ({
    ...message,
    handoffs: message.handoffs?.length
      ? message.handoffs.map((handoff) =>
          handoffOf ? handoffOf(handoff) : viewHandoff(handoff),
        )
      : undefined,
    copyAlways: index === latestResponseIndex,
    copyText: isPlainMessage(message) ? message.text : undefined,
    editable: index === editableIndex,
    editText: index === editableIndex ? message.text : undefined,
    id: chatMessageItemId(message, index),
    onTurnIntoIssue:
      message.idea && onTurnIntoIssue
        ? () => onTurnIntoIssue(message.idea ?? "")
        : undefined,
    sentBy:
      message.role === "user" && message.sentBySessionId
        ? senderOf?.(message.sentBySessionId)
        : undefined,
    onStopSteerBlocker:
      message.steerBlockerTask && stopTask
        ? () =>
            stopTask(
              message.steerBlockerTask!.sessionId,
              message.steerBlockerTask!.taskId,
            )
        : undefined,
  }));
}

/**
 * Sessions' transcripts as a chat shows them, outside a chat: an Issue's
 * conversation shows its executions this way (through the app shell). Its
 * host takes messages itself, so none is editable here.
 */
export function sessionTranscriptItems(
  sessions: AgentSession[],
  devices?: readonly DeviceProjection[],
): ChatMessageItem[] {
  return chatMessageItems(
    chatMessagesForThread({ id: "", title: "", sessions }, { devices }),
    { agentActive: true },
  );
}
