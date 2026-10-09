import { useEffect, useRef, useState } from "react";
import type {
  ChatQueue,
  ChatQueueItem,
  ChatQueueRunSettings,
} from "@bd777/foundry-protocol";
import {
  deleteChatQueueItem,
  editChatQueueItem,
  enqueueChatMessage,
  getChatQueue,
  reorderChatQueue,
  retryChatQueueItem,
  steerChatQueueItem,
  subscribeFoundryEvents,
  type ChatQueueResult,
} from "../../api";
import type {
  ConversationQueueOutcome,
  ConversationServerQueue,
  QueuedDraft,
} from "../../components/conversation/conversation-types";

/** The transport the chat queue uses; tests replace it. */
export interface ChatQueueTransport {
  get: (chatId: string) => Promise<ChatQueueResult>;
  enqueue: typeof enqueueChatMessage;
  edit: typeof editChatQueueItem;
  remove: typeof deleteChatQueueItem;
  reorder: typeof reorderChatQueue;
  steer: typeof steerChatQueueItem;
  retry: typeof retryChatQueueItem;
  /** Queues other tabs and devices change; onOpen also after a reconnect. */
  subscribe: (
    onQueue: (queue: ChatQueue) => void,
    onOpen: () => void,
  ) => () => void;
}

export const chatQueueTransport: ChatQueueTransport = {
  get: (chatId) => getChatQueue(chatId),
  enqueue: enqueueChatMessage,
  edit: editChatQueueItem,
  remove: deleteChatQueueItem,
  reorder: reorderChatQueue,
  steer: steerChatQueueItem,
  retry: retryChatQueueItem,
  subscribe: (onQueue, onOpen) =>
    subscribeFoundryEvents(
      (event) => {
        if (event.type === "chat_queue_changed") onQueue(event.payload);
      },
      { onOpen },
    ),
};

function draftOf(item: ChatQueueItem): QueuedDraft {
  return {
    id: item.id,
    text: item.text,
    attachments: item.attachments,
    state: item.state === "sent" ? "dispatching" : item.state,
    error: item.error,
    revision: item.revision,
  };
}

function outcomeOf(result: ChatQueueResult): ConversationQueueOutcome {
  if (result.ok) return { ok: true };
  if (result.code === "already_sent" || result.code === "sending")
    return { ok: false, reason: "sent" };
  if (result.code === "changed") return { ok: false, reason: "changed" };
  return { ok: false, reason: "failed", message: result.error };
}

/**
 * The selected chat's queue as the server keeps it. Every tab renders the
 * server's list; a change shows at once and is rolled back when the server
 * refuses it, which also answers with the queue as it is.
 */
export function useChatQueue({
  workspaceId,
  chatId,
  runSettings,
  transport = chatQueueTransport,
}: {
  workspaceId: string;
  /** The selected chat's server id; undefined for a chat not started yet. */
  chatId?: string;
  /** The composer's choices, read when a message is queued. */
  runSettings: () => ChatQueueRunSettings;
  transport?: ChatQueueTransport;
}): ConversationServerQueue {
  const [queues, setQueues] = useState<Record<string, ChatQueue>>({});
  const queuesRef = useRef(queues);
  const settings = useRef(runSettings);
  settings.current = runSettings;
  const selected = useRef(chatId);
  selected.current = chatId;

  function put(queue: ChatQueue) {
    queuesRef.current = { ...queuesRef.current, [queue.chatId]: queue };
    setQueues(queuesRef.current);
  }
  /**
   * Keeps the newest revision the server reported: older answers arrive
   * late, and one as old as what is shown would undo a change in flight.
   */
  function accept(queue: ChatQueue | undefined) {
    if (!queue || queue.workspaceId !== workspaceId) return;
    const known = queuesRef.current[queue.chatId];
    if (!known || queue.revision > known.revision) put(queue);
  }
  async function load(id: string) {
    try {
      const result = await transport.get(id);
      if (result.ok) accept(result.queue);
    } catch {
      // The stream and the next change repair a missed read.
    }
  }
  /**
   * Shows change applied to the queue at once, then the server's answer: the
   * queue after it, or, refused, the queue as it is (a failed request puts
   * back what was shown).
   */
  async function change(
    id: string,
    optimistic: ((items: ChatQueueItem[]) => ChatQueueItem[]) | undefined,
    request: (queue: ChatQueue | undefined) => Promise<ChatQueueResult>,
  ): Promise<ConversationQueueOutcome> {
    const before = queuesRef.current[id];
    if (before && optimistic)
      put({ ...before, items: optimistic(before.items) });
    let result: ChatQueueResult;
    try {
      result = await request(before);
    } catch (reason) {
      result = {
        ok: false,
        status: 0,
        error: reason instanceof Error ? reason.message : String(reason),
      };
    }
    if (result.ok) accept(result.queue);
    else if (result.queue) put(newest(result.queue, queuesRef.current[id]));
    else if (before && queuesRef.current[id]?.revision === before.revision)
      put(before);
    return outcomeOf(result);
  }

  useEffect(() => {
    return transport.subscribe(accept, () => {
      if (selected.current) void load(selected.current);
    });
  }, [workspaceId, transport]);
  useEffect(() => {
    if (chatId) void load(chatId);
  }, [workspaceId, chatId]);

  const queue = chatId ? queues[chatId] : undefined;
  return {
    chatId,
    items: queue?.items.map(draftOf),
    async enqueue(id, message) {
      const result = await change(id, undefined, () =>
        transport.enqueue(
          id,
          {
            text: message.text,
            attachments: message.attachments,
            runSettings: settings.current(),
          },
          message.id,
        ),
      );
      // The key was used before with other settings: the message is there.
      return !result.ok &&
        result.reason === "failed" &&
        /idempotency/.test(result.message ?? "")
        ? { ok: true }
        : result;
    },
    edit: (id, itemId, text) =>
      change(
        id,
        (items) =>
          items.map((item) => (item.id === itemId ? { ...item, text } : item)),
        (current) =>
          transport.edit(id, itemId, {
            text,
            expectedRevision:
              current?.items.find((item) => item.id === itemId)?.revision ?? 0,
          }),
      ),
    remove: (id, itemId) =>
      change(
        id,
        (items) => items.filter((item) => item.id !== itemId),
        () => transport.remove(id, itemId),
      ),
    reorder: (id, itemIds) =>
      change(
        id,
        (items) => [
          ...items.filter((item) => !itemIds.includes(item.id)),
          ...itemIds.flatMap((itemId) =>
            items.filter((item) => item.id === itemId),
          ),
        ],
        (current) => transport.reorder(id, itemIds, current?.revision ?? 0),
      ),
    steer: (id, itemId) =>
      change(
        id,
        (items) =>
          items.map((item) =>
            item.id === itemId ? { ...item, state: "dispatching" } : item,
          ),
        () => transport.steer(id, itemId),
      ),
    retry: (id, itemId) =>
      change(
        id,
        (items) => [
          ...items
            .filter((item) => item.id === itemId)
            .map((item) => ({ ...item, state: "queued" as const, error: "" })),
          ...items.filter((item) => item.id !== itemId),
        ],
        () => transport.retry(id, itemId),
      ),
  };
}

function newest(queue: ChatQueue, known: ChatQueue | undefined): ChatQueue {
  return known && known.revision > queue.revision ? known : queue;
}
