import { useEffect, useRef, useState } from "react";
import type { ConversationProps, QueuedDraft } from "./conversation-types";
import {
  claimIsLive,
  claimQueuedDraft,
  conversationStorageKey,
  holdDispatchLock,
  readConversation,
  updateConversation,
} from "./conversation-storage";

function withoutClaim({
  sending: _sending,
  ...item
}: QueuedDraft): QueuedDraft {
  return item;
}

/**
 * Messages this browser keeps and sends (conversations without a server
 * queue), shared with its other tabs through storage. One tab, the
 * dispatcher, drains a stored queue; the others show it.
 */
export function useLocalQueue({
  storageKeyPrefix,
  threadKey,
  serverMode,
}: Pick<ConversationProps, "storageKeyPrefix" | "threadKey"> & {
  serverMode: boolean;
}) {
  const storageKey = conversationStorageKey(storageKeyPrefix, threadKey);
  const [tab] = useState(() => crypto.randomUUID());
  const [queues, setQueues] = useState<Record<string, QueuedDraft[]>>({});
  const queuesRef = useRef(queues);
  // Threads whose last write failed: memory is their only complete copy.
  const unsaved = useRef(new Set<string>());
  const [dispatcher, setDispatcher] = useState(!storageKey);
  const prefix = useRef(storageKeyPrefix);
  prefix.current = storageKeyPrefix;

  function keyFor(key: string) {
    return conversationStorageKey(prefix.current, key);
  }
  function storedQueue(key: string): QueuedDraft[] | undefined {
    const stored = keyFor(key);
    if (!stored || serverMode || unsaved.current.has(key)) return undefined;
    return readConversation(stored)?.queue;
  }
  function setQueue(key: string, list: QueuedDraft[]) {
    queuesRef.current = { ...queuesRef.current, [key]: list };
    setQueues(queuesRef.current);
  }
  /** Changes a queue against its stored copy, which other tabs may have changed. */
  function mutate(key: string, change: (list: QueuedDraft[]) => QueuedDraft[]) {
    const next = change(storedQueue(key) ?? queuesRef.current[key] ?? []);
    const stored = keyFor(key);
    if (stored) {
      if (updateConversation(stored, () => ({ queue: next })))
        unsaved.current.delete(key);
      else unsaved.current.add(key);
    }
    setQueue(key, next);
  }
  function sync(key: string) {
    const stored = storedQueue(key);
    if (stored) setQueue(key, stored);
  }

  // Another tab changed a stored queue (enqueued, sent or removed a message).
  useEffect(() => {
    if (!storageKeyPrefix || serverMode) return;
    const storagePrefix = `${storageKeyPrefix}:`;
    const onStorage = (event: StorageEvent) => {
      if (event.key === null) {
        Object.keys(queuesRef.current).forEach(sync);
      } else if (event.key.startsWith(storagePrefix)) {
        const key = event.key.slice(storagePrefix.length);
        if (key in queuesRef.current) sync(key);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKeyPrefix, serverMode]);
  useEffect(() => {
    if (!(threadKey in queuesRef.current)) sync(threadKey);
  }, [threadKey, storageKeyPrefix]);
  // One tab drains a stored queue; the others show it and take over on leaving.
  useEffect(() => {
    if (!storageKey || serverMode) {
      setDispatcher(!serverMode);
      return;
    }
    setDispatcher(false);
    return holdDispatchLock(storageKey, () => setDispatcher(true));
  }, [storageKey, serverMode]);

  return {
    /** The shown conversation's messages. */
    items: queues[threadKey] ?? [],
    /** This tab drains the shown conversation's queue. */
    dispatcher,
    append(key: string, item: QueuedDraft) {
      mutate(key, (list) => [...list, item]);
    },
    remove(id: string, key: string) {
      mutate(key, (list) => list.filter((item) => item.id !== id));
    },
    /** A send failed: the message waits again, claimed by no tab. */
    unclaim(id: string, key: string) {
      mutate(key, (list) =>
        list.map((entry) => (entry.id === id ? withoutClaim(entry) : entry)),
      );
    },
    move(
      key: string,
      id: string,
      direction: "before" | "after",
      targetId: string,
    ) {
      mutate(key, (list) => {
        const item = list.find((entry) => entry.id === id);
        if (!item || id === targetId) return list;
        const rest = list.filter((entry) => entry.id !== id);
        const target = rest.findIndex((entry) => entry.id === targetId);
        if (target < 0) return list;
        rest.splice(target + (direction === "after" ? 1 : 0), 0, item);
        return rest;
      });
    },
    /** The conversation moved to a new key; its waiting messages follow. */
    carry(from: string, to: string) {
      const moving = serverMode
        ? []
        : (storedQueue(from) ?? queuesRef.current[from] ?? []);
      if (!moving.length) return;
      mutate(from, () => []);
      mutate(to, (list) => [
        ...moving,
        ...list.filter((item) => !moving.some((entry) => entry.id === item.id)),
      ]);
    },
    /**
     * Claims a queued message in storage so no other tab sends it too.
     * "skip" when it must not be sent now: already sent, or another tab is
     * sending it. A claim whose tab closed mid-request may have reached the
     * server ("maybeSent"), so it waits for the person unless they asked to
     * send it (`force`).
     */
    async claim(
      item: QueuedDraft,
      key: string,
      force: boolean,
    ): Promise<"send" | "skip" | "maybeSent"> {
      const stored = keyFor(key);
      if (!stored || unsaved.current.has(key)) return "send";
      let claimed = claimQueuedDraft(stored, item.id, tab);
      if (claimed.result === "elsewhere") {
        if (await claimIsLive(claimed.item)) {
          sync(key);
          return "skip";
        }
        if (!force) {
          sync(key);
          return "maybeSent";
        }
        claimed = claimQueuedDraft(stored, item.id, tab, true);
      }
      if (claimed.result === "gone") {
        sync(key);
        return "skip";
      }
      if (claimed.result === "claimed") sync(key);
      return "send";
    },
  };
}

export type LocalQueue = ReturnType<typeof useLocalQueue>;
