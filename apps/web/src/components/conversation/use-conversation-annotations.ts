import { useRef, useState } from "react";
import { annotationLimits, type ConversationAnnotation } from "./annotations";
import {
  conversationStorageKey,
  readConversation,
  updateConversation,
} from "./conversation-storage";
import type { ConversationProps } from "./conversation-types";

/**
 * The annotations on answers a conversation's composer will send: kept in
 * memory per conversation and written to the same browser entry as the draft,
 * so they survive a reload where the draft does.
 */
export function useConversationAnnotations({
  storageKeyPrefix,
  threadKey,
}: Pick<ConversationProps, "storageKeyPrefix" | "threadKey">) {
  const [byThread, setByThread] = useState<
    Record<string, ConversationAnnotation[]>
  >({});
  const byThreadRef = useRef(byThread);

  function storedAnnotations(key: string): ConversationAnnotation[] {
    const stored = conversationStorageKey(storageKeyPrefix, key);
    return stored ? (readConversation(stored)?.annotations ?? []) : [];
  }

  function read(key = threadKey): ConversationAnnotation[] {
    return byThreadRef.current[key] ?? storedAnnotations(key);
  }

  function write(key: string, next: ConversationAnnotation[]) {
    byThreadRef.current = { ...byThreadRef.current, [key]: next };
    setByThread(byThreadRef.current);
    const stored = conversationStorageKey(storageKeyPrefix, key);
    if (stored) updateConversation(stored, () => ({ annotations: next }));
  }

  return {
    /** The shown conversation's annotations. */
    annotations: read(threadKey),
    /** A conversation's annotations, as typed in this tab or stored. */
    read,
    /** Puts a queued message's annotations back into the composer's draft. */
    restore(list: readonly ConversationAnnotation[], key = threadKey) {
      const current = read(key);
      const added = list.filter(
        (annotation) => !current.some((item) => item.id === annotation.id),
      );
      if (added.length) write(key, [...current, ...added]);
    },
    /** Adds one, unless the draft already holds the most allowed. */
    add(annotation: ConversationAnnotation, key = threadKey): boolean {
      const current = read(key);
      if (current.length >= annotationLimits.maxItems) return false;
      write(key, [...current, annotation]);
      return true;
    },
    update(
      id: string,
      change: Pick<ConversationAnnotation, "comment">,
      key = threadKey,
    ) {
      write(
        key,
        read(key).map((item) =>
          item.id === id ? { ...item, ...change } : item,
        ),
      );
    },
    remove(id: string, key = threadKey) {
      write(
        key,
        read(key).filter((item) => item.id !== id),
      );
    },
    clear(key = threadKey) {
      if (read(key).length > 0) write(key, []);
    },
  };
}

export type ConversationAnnotations = ReturnType<
  typeof useConversationAnnotations
>;
