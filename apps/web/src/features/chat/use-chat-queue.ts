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
  type ChatQueueResult,
} from "../../api";
import {
  foundryStreamEpoch,
  foundryStreamOpened,
  onStreamEvent,
} from "../../stream";
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
  /**
   * Queues other tabs and devices change; onResync when events may have been
   * missed (a connection that resumes replays them instead).
   */
  subscribe: (
    onQueue: (queue: ChatQueue) => void,
    onResync: () => void,
  ) => () => void;
  /**
   * Resolves when a read may start (see foundryStreamOpened); without it a
   * read starts at once.
   */
  opened?: () => Promise<unknown>;
  /**
   * The stream's epoch (see foundryStreamEpoch): a queue read or heard at
   * the current one is not read again. Without it every selection reads.
   */
  epoch?: () => number;
}

export const chatQueueTransport: ChatQueueTransport = {
  get: (chatId) => getChatQueue(chatId),
  enqueue: enqueueChatMessage,
  edit: editChatQueueItem,
  remove: deleteChatQueueItem,
  reorder: reorderChatQueue,
  steer: steerChatQueueItem,
  retry: retryChatQueueItem,
  subscribe: (onQueue, onResync) =>
    onStreamEvent("chat_queue_changed", onQueue, { onResync }),
  opened: foundryStreamOpened,
  epoch: foundryStreamEpoch,
};

function draftOf(item: ChatQueueItem): QueuedDraft {
  return {
    id: item.id,
    text: item.text,
    attachments: item.attachments,
    state: item.state === "sent" ? "dispatching" : item.state,
    error: item.error,
    maybeSent: item.maybeSent,
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
 * refuses it, which also answers with the queue as it is. A chat's queue is
 * read when it is selected (once the stream opened) unless it was read or
 * pushed at the stream's current epoch; a resync reads the selected one.
 */
export function useChatQueue({
  workspaceId,
  chatId,
  onSent,
  runSettings,
  transport = chatQueueTransport,
}: {
  workspaceId: string;
  /** The selected chat's server id; undefined for a chat not started yet. */
  chatId?: string;
  /** The composer's choices, read when a message is queued. */
  runSettings: () => ChatQueueRunSettings;
  /**
   * Messages the server sent into the chat: they leave the queue, and the
   * transcript shows them until their own event arrives.
   */
  onSent?: (chatId: string, items: ChatQueueItem[]) => void;
  transport?: ChatQueueTransport;
}): ConversationServerQueue {
  const [queues, setQueues] = useState<Record<string, ChatQueue>>({});
  const queuesRef = useRef(queues);
  const settings = useRef(runSettings);
  settings.current = runSettings;
  const selected = useRef(chatId);
  selected.current = chatId;
  const sentRef = useRef(onSent);
  sentRef.current = onSent;
  /** The stream epoch each chat's queue is current at. */
  const currentAt = useRef(new Map<string, number>());
  /** The epoch each running read started at. */
  const readingAt = useRef(new Map<string, number>());
  /** The selected chat's first read, while it waits for the stream. */
  const waiting = useRef<{ chatId: string }>(undefined);
  const epochNow = () => transport.epoch?.() ?? -1;
  /** Read or heard at the current epoch, or being read since it began. */
  const current = (id: string) =>
    transport.epoch !== undefined &&
    (currentAt.current.get(id) === epochNow() ||
      readingAt.current.get(id) === epochNow());

  function put(queue: ChatQueue) {
    const known = queuesRef.current[queue.chatId];
    if (known && queue.revision > known.revision) {
      // Left the queue while being sent, or now marked sent: delivered.
      const sent = known.items.filter((item) => {
        const now = queue.items.find((entry) => entry.id === item.id);
        return now
          ? now.state === "sent" && item.state !== "sent"
          : item.state === "dispatching" || item.state === "sent";
      });
      if (sent.length) sentRef.current?.(queue.chatId, sent);
    }
    queuesRef.current = { ...queuesRef.current, [queue.chatId]: queue };
    setQueues(queuesRef.current);
  }
  /**
   * Keeps the newest revision the server reported: older answers arrive
   * late, and one as old as what is shown would undo a change in flight.
   * `epoch` is the stream's when the server was asked (or now, for a push).
   */
  function accept(queue: ChatQueue | undefined, epoch: number) {
    if (!queue) return;
    if (queue.workspaceId !== workspaceId) {
      // Another workspace's chat changed: what is held of it is stale.
      currentAt.current.delete(queue.chatId);
      return;
    }
    const known = queuesRef.current[queue.chatId];
    if (!known || queue.revision > known.revision) {
      put(queue);
      currentAt.current.set(queue.chatId, epoch);
    } else if (queue.revision === known.revision)
      currentAt.current.set(
        queue.chatId,
        Math.max(epoch, currentAt.current.get(queue.chatId) ?? -1),
      );
  }
  async function load(id: string) {
    const epoch = epochNow();
    readingAt.current.set(id, epoch);
    try {
      const result = await transport.get(id);
      if (result.ok) accept(result.queue, epoch);
    } catch {
      // The stream and the next change repair a missed read.
    } finally {
      if (readingAt.current.get(id) === epoch) readingAt.current.delete(id);
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
    const epoch = epochNow();
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
    if (result.ok) accept(result.queue, epoch);
    else if (result.queue) put(newest(result.queue, queuesRef.current[id]));
    else if (before && queuesRef.current[id]?.revision === before.revision)
      put(before);
    return outcomeOf(result);
  }

  useEffect(() => {
    return transport.subscribe(
      (queue) => accept(queue, epochNow()),
      () => {
        // Other chats' queues are stale now and read when selected.
        const id = selected.current;
        if (id && waiting.current?.chatId !== id && !current(id)) void load(id);
      },
    );
  }, [workspaceId, transport]);
  useEffect(() => {
    if (!chatId || current(chatId)) return;
    const wait = { chatId };
    waiting.current = wait;
    void (transport.opened?.() ?? Promise.resolve()).then(() => {
      if (waiting.current !== wait) return;
      waiting.current = undefined;
      if (!current(chatId)) void load(chatId);
    });
    return () => {
      if (waiting.current === wait) waiting.current = undefined;
    };
  }, [workspaceId, chatId]);

  const queue = chatId ? queues[chatId] : undefined;
  return {
    chatId,
    items: queue?.items.map(draftOf),
    async enqueue(id, message, options) {
      const result = await change(id, undefined, () =>
        transport.enqueue(
          id,
          {
            text: message.text,
            attachments: message.attachments,
            runSettings: settings.current(),
            ...(options?.steer ? { steer: true } : {}),
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
