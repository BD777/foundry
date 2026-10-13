import { useEffect, useRef, useState } from "react";
import {
  conversationStorageGeneration,
  conversationStorageKey,
  pruneConversationStorage,
  readConversation,
  updateConversation,
} from "./conversation-storage";
import type { ConversationProps } from "./conversation-types";

const draftWriteDelayMs = 400;
let storagePruned = false;

/**
 * The composer text of every conversation this input has shown: kept in
 * memory, written to browser storage shortly after typing stops and when
 * the page is hidden.
 */
export function useConversationDrafts({
  storageKeyPrefix,
  threadKey,
  draftResetKey,
}: Pick<
  ConversationProps,
  "storageKeyPrefix" | "threadKey" | "draftResetKey"
>) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftRef = useRef(drafts);
  // Pending draft writes, with the storage generation they were typed in.
  const draftWrites = useRef(
    new Map<string, { text: string; generation: number }>(),
  );
  const draftWriteTimer = useRef<number | undefined>(undefined);
  const prefix = useRef(storageKeyPrefix);
  prefix.current = storageKeyPrefix;
  const previousReset = useRef(draftResetKey);

  function storedDraft(key: string): string {
    const stored = conversationStorageKey(prefix.current, key);
    return stored ? (readConversation(stored)?.draft ?? "") : "";
  }
  function flushDrafts() {
    window.clearTimeout(draftWriteTimer.current);
    const writes = [...draftWrites.current];
    draftWrites.current.clear();
    // Signing out wiped storage; a draft typed before must not return.
    for (const [stored, { text, generation }] of writes)
      if (generation === conversationStorageGeneration())
        updateConversation(stored, () => ({ draft: text }));
  }
  function updateDraft(value: string, key = threadKey) {
    draftRef.current = { ...draftRef.current, [key]: value };
    setDrafts(draftRef.current);
    const stored = conversationStorageKey(prefix.current, key);
    if (!stored) return;
    draftWrites.current.set(stored, {
      text: value,
      generation: conversationStorageGeneration(),
    });
    window.clearTimeout(draftWriteTimer.current);
    draftWriteTimer.current = window.setTimeout(flushDrafts, draftWriteDelayMs);
  }

  useEffect(() => {
    if (storageKeyPrefix && !storagePruned) {
      storagePruned = true;
      pruneConversationStorage();
    }
    const flushNow = () => {
      if (document.visibilityState !== "visible") flushDrafts();
    };
    window.addEventListener("pagehide", flushDrafts);
    document.addEventListener("visibilitychange", flushNow);
    return () => {
      window.removeEventListener("pagehide", flushDrafts);
      document.removeEventListener("visibilitychange", flushNow);
      flushDrafts();
    };
  }, []);
  useEffect(() => {
    if (threadKey in draftRef.current) return;
    const restored = storedDraft(threadKey);
    if (restored) {
      draftRef.current = { ...draftRef.current, [threadKey]: restored };
      setDrafts(draftRef.current);
    }
  }, [threadKey, storageKeyPrefix]);
  useEffect(() => {
    if (previousReset.current !== draftResetKey) updateDraft("");
    previousReset.current = draftResetKey;
  }, [draftResetKey]);

  return {
    /** The shown conversation's composer text. */
    draft: drafts[threadKey] ?? storedDraft(threadKey),
    /** A conversation's text as typed in this tab, if any. */
    typed: (key: string): string | undefined => draftRef.current[key],
    /** A conversation's text: typed here, or else stored. */
    read: (key: string): string => draftRef.current[key] ?? storedDraft(key),
    update: updateDraft,
    flush: flushDrafts,
  };
}

export type ConversationDrafts = ReturnType<typeof useConversationDrafts>;
