import { useEffect, useRef, useState } from "react";
import { i18n } from "../../i18n";
import type {
  ConversationQueueOutcome,
  ConversationServerQueue,
  QueuedDraft,
} from "./conversation-types";
import { readConversation, updateConversation } from "./conversation-storage";

function outcomeMessage(outcome: ConversationQueueOutcome): string {
  if (outcome.ok) return "";
  if (outcome.reason === "sent")
    return i18n.t("conversation:errors.alreadySent");
  if (outcome.reason === "changed")
    return i18n.t("conversation:errors.queueChanged");
  return outcome.message ?? i18n.t("conversation:errors.queueFailed");
}

/**
 * One conversation's view of a queue the server keeps and sends. Messages
 * queued while this tab cannot hand them over yet (the conversation has no
 * server id, or a message this tab sent is still on its way, or a failure
 * paused the queue) wait here, in memory, and go to the server in order.
 */
export function useServerQueue(options: {
  server?: ConversationServerQueue;
  threadKey: string;
  /** The browser entry whose queued messages move to the server. */
  storageKey?: string;
  /** A message this tab sent is on its way; later ones must wait for it. */
  holding: boolean;
  paused: boolean;
  /** A message could not reach the server: shown, and the queue pauses. */
  onFailure: (message: string, key: string) => void;
  /** Text an edit kept after its message was sent. */
  onKeepText: (text: string) => void;
}) {
  const { server, threadKey, storageKey, holding, paused } = options;
  const current = useRef(options);
  current.current = options;
  const [outbox, setOutboxState] = useState<Record<string, QueuedDraft[]>>({});
  const outboxRef = useRef(outbox);
  const [previewOrder, setPreviewOrder] = useState<string[]>();
  const [notice, setNotice] = useState<Record<string, string>>({});
  const flushing = useRef(false);
  // Messages that came from browser storage, removed there once the server
  // has them; and the entries already read.
  const migrated = useRef(new Map<string, string>());
  const migratedStorage = useRef(new Set<string>());

  function setOutbox(key: string, list: QueuedDraft[]) {
    outboxRef.current = { ...outboxRef.current, [key]: list };
    setOutboxState(outboxRef.current);
  }
  function show(outcome: ConversationQueueOutcome, key = threadKey) {
    setNotice((value) => ({ ...value, [key]: outcomeMessage(outcome) }));
    return outcome.ok;
  }

  // Messages a browser kept before the server did move to it once.
  useEffect(() => {
    if (!server || !server.chatId || !storageKey) return;
    if (migratedStorage.current.has(storageKey)) return;
    migratedStorage.current.add(storageKey);
    const stored = readConversation(storageKey)?.queue ?? [];
    if (!stored.length) return;
    const moving = stored.map((item) => {
      migrated.current.set(item.id, storageKey);
      return { ...item, state: "local" as const };
    });
    setOutbox(threadKey, [...moving, ...(outboxRef.current[threadKey] ?? [])]);
    // One a closed tab was sending may already be in the conversation: it
    // waits here for the person; the others go on.
    if (moving.some((item) => item.sending))
      setNotice((value) => ({
        ...value,
        [threadKey]: i18n.t("conversation:errors.maybeSentMarked"),
      }));
  }, [server?.chatId, storageKey, threadKey]);

  // Hand waiting messages to the server, in order, once it can take them.
  // One a closed tab may have sent waits for the person instead.
  const waiting = outbox[threadKey];
  useEffect(() => {
    const target = current.current.server;
    const chatId = target?.chatId;
    const next = waiting?.find((item) => !item.sending);
    if (!target || !chatId || !next || holding || paused) return;
    if (flushing.current) return;
    const key = threadKey;
    flushing.current = true;
    void target
      .enqueue(chatId, next)
      .then((outcome) => {
        if (!outcome.ok) {
          current.current.onFailure(outcomeMessage(outcome), key);
          return;
        }
        setOutbox(
          key,
          (outboxRef.current[key] ?? []).filter((item) => item.id !== next.id),
        );
        const stored = migrated.current.get(next.id);
        if (stored) {
          migrated.current.delete(next.id);
          updateConversation(stored, (entry) => ({
            queue: entry.queue.filter((item) => item.id !== next.id),
          }));
        }
      })
      .finally(() => {
        flushing.current = false;
      });
  }, [server?.chatId, waiting, holding, paused, threadKey]);

  const serverItems = server?.chatId ? (server.items ?? []) : [];
  const ordered = previewOrder
    ? [...serverItems].sort(
        (left, right) =>
          previewOrder.indexOf(left.id) - previewOrder.indexOf(right.id),
      )
    : serverItems;
  const local = outbox[threadKey] ?? [];

  function isLocal(item: QueuedDraft) {
    return item.state === "local";
  }
  function removeLocal(id: string, key = threadKey) {
    setOutbox(
      key,
      (outboxRef.current[key] ?? []).filter((item) => item.id !== id),
    );
    const stored = migrated.current.get(id);
    if (stored) {
      migrated.current.delete(id);
      updateConversation(stored, (entry) => ({
        queue: entry.queue.filter((item) => item.id !== id),
      }));
    }
  }

  return {
    enabled: Boolean(server),
    items: [...ordered, ...local],
    notice: notice[threadKey] ?? "",
    isLocal,
    /** Queues a message; it reaches the server as soon as it can. */
    add(item: QueuedDraft, key = threadKey, { first = false } = {}) {
      const list = outboxRef.current[key] ?? [];
      const added = { ...item, state: "local" as const };
      setOutbox(key, first ? [added, ...list] : [...list, added]);
    },
    /** An accepted message gave the conversation a new key. */
    moveThread(from: string, to: string) {
      const moving = outboxRef.current[from] ?? [];
      if (!moving.length) return;
      setOutbox(from, []);
      setOutbox(to, [...moving, ...(outboxRef.current[to] ?? [])]);
    },
    removeLocal,
    async remove(item: QueuedDraft) {
      if (isLocal(item)) return removeLocal(item.id);
      if (server?.chatId) show(await server.remove(server.chatId, item.id));
    },
    async edit(item: QueuedDraft, text: string) {
      const trimmed = text.trim();
      if (!trimmed && !item.attachments?.length) return false;
      if (isLocal(item)) {
        setOutbox(
          threadKey,
          (outboxRef.current[threadKey] ?? []).map((entry) =>
            entry.id === item.id ? { ...entry, text: trimmed } : entry,
          ),
        );
        return true;
      }
      if (!server?.chatId) return false;
      const outcome = await server.edit(server.chatId, item.id, trimmed);
      if (!outcome.ok && outcome.reason === "sent")
        current.current.onKeepText(trimmed);
      return show(outcome);
    },
    /** Shows a dragged message's new place among its own kind. */
    move(id: string, direction: "before" | "after", targetId: string) {
      const group = local.some((item) => item.id === id) ? local : ordered;
      if (id === targetId || !group.some((item) => item.id === targetId))
        return;
      const ids = group.map((item) => item.id).filter((entry) => entry !== id);
      const target = ids.indexOf(targetId);
      ids.splice(target + (direction === "after" ? 1 : 0), 0, id);
      if (group === local)
        setOutbox(
          threadKey,
          ids.flatMap((entry) => local.filter((item) => item.id === entry)),
        );
      else setPreviewOrder(ids);
    },
    /** A drag ended: the server takes the order shown. */
    async commitOrder() {
      const order = previewOrder;
      if (!order || !server?.chatId) return;
      const ids = order.filter((id) =>
        serverItems.some(
          (item) => item.id === id && item.state !== "dispatching",
        ),
      );
      const outcome = await server.reorder(server.chatId, ids);
      setPreviewOrder(undefined);
      show(outcome);
    },
    /** Moves a message one place among its own kind, without a drag. */
    async shift(item: QueuedDraft, offset: -1 | 1) {
      if (isLocal(item)) {
        const index = local.findIndex((entry) => entry.id === item.id);
        const swap = index + offset;
        if (index < 0 || swap < 0 || swap >= local.length) return;
        const next = local.filter((entry) => entry.id !== item.id);
        next.splice(swap, 0, item);
        setOutbox(threadKey, next);
        return;
      }
      if (!server?.chatId) return;
      const ids = serverItems
        .filter((entry) => entry.state !== "dispatching")
        .map((entry) => entry.id);
      const index = ids.indexOf(item.id);
      const swap = index + offset;
      if (index < 0 || swap < 0 || swap >= ids.length) return;
      ids.splice(index, 1);
      ids.splice(swap, 0, item.id);
      show(await server.reorder(server.chatId, ids));
    },
    async steer(item: QueuedDraft) {
      if (!server?.chatId) return false;
      return show(await server.steer(server.chatId, item.id));
    },
    async retry(item: QueuedDraft) {
      if (!server?.chatId) return;
      show(await server.retry(server.chatId, item.id));
    },
  };
}
