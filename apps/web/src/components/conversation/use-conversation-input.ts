import { useEffect, useRef, useState } from "react";
import { i18n } from "../../i18n";
import type { ConversationProps, QueuedDraft } from "./conversation-types";
import {
  claimIsLive,
  claimQueuedDraft,
  conversationStorageGeneration,
  conversationStorageKey,
  holdDispatchLock,
  pruneConversationStorage,
  readConversation,
  updateConversation,
  whileSending,
} from "./conversation-storage";

const draftWriteDelayMs = 400;
let storagePruned = false;

function withoutClaim({
  sending: _sending,
  ...item
}: QueuedDraft): QueuedDraft {
  return item;
}

/** One input lifecycle for every conversation, independent of its transport. */
export function useConversationInput(
  props: ConversationProps,
  followLatest: () => void,
) {
  const { threadKey, storageKeyPrefix, draftResetKey } = props;
  const storageKey = conversationStorageKey(storageKeyPrefix, threadKey);
  const [tab] = useState(() => crypto.randomUUID());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftRef = useRef(drafts);
  const [queues, setQueues] = useState<Record<string, QueuedDraft[]>>({});
  const queuesRef = useRef(queues);
  // Threads whose last write failed: memory is their only complete copy.
  const unsaved = useRef(new Set<string>());
  // Pending draft writes, with the storage generation they were typed in.
  const draftWrites = useRef(
    new Map<string, { text: string; generation: number }>(),
  );
  const draftWriteTimer = useRef<number | undefined>(undefined);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pausedQueues, setPausedQueues] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState(false);
  const [dispatcher, setDispatcher] = useState(!storageKey);
  const [awaitingExecution, setAwaitingExecution] = useState<
    Record<string, string | undefined>
  >({});
  const awaitingRef = useRef(awaitingExecution);
  awaitingRef.current = awaitingExecution;
  const [steeringId, setSteeringId] = useState<string>();
  const busy = useRef(false);
  const current = useRef(props);
  current.current = props;
  const previousReset = useRef(draftResetKey);
  const queue = queues[threadKey] ?? [];
  const draft = drafts[threadKey] ?? storedDraft(threadKey);
  const runtime =
    props.composer.mode === "fixed"
      ? props.composer.runtime
      : props.composer.runtimeControls.selectedRuntime;
  const active = Boolean(
    props.active || props.sending || pending || threadKey in awaitingExecution,
  );
  const canSteer = Boolean(
    props.active && runtime === "claude" && props.onSteer,
  );
  const unavailable = Boolean(
    props.disabled || props.readOnly || props.attachmentUploading,
  );

  function keyFor(key: string) {
    return conversationStorageKey(current.current.storageKeyPrefix, key);
  }
  function storedDraft(key: string): string {
    const stored = keyFor(key);
    return stored ? (readConversation(stored)?.draft ?? "") : "";
  }
  function storedQueue(key: string): QueuedDraft[] | undefined {
    const stored = keyFor(key);
    if (!stored || unsaved.current.has(key)) return undefined;
    return readConversation(stored)?.queue;
  }
  function setQueue(key: string, list: QueuedDraft[]) {
    queuesRef.current = { ...queuesRef.current, [key]: list };
    setQueues(queuesRef.current);
  }
  /** Changes a queue against its stored copy, which other tabs may have changed. */
  function mutateQueue(
    key: string,
    change: (list: QueuedDraft[]) => QueuedDraft[],
  ) {
    const next = change(storedQueue(key) ?? queuesRef.current[key] ?? []);
    const stored = keyFor(key);
    if (stored) {
      if (updateConversation(stored, () => ({ queue: next })))
        unsaved.current.delete(key);
      else unsaved.current.add(key);
    }
    setQueue(key, next);
  }
  function syncQueue(key: string) {
    const stored = storedQueue(key);
    if (stored) setQueue(key, stored);
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
    const stored = keyFor(key);
    if (!stored) return;
    draftWrites.current.set(stored, {
      text: value,
      generation: conversationStorageGeneration(),
    });
    window.clearTimeout(draftWriteTimer.current);
    draftWriteTimer.current = window.setTimeout(flushDrafts, draftWriteDelayMs);
  }
  /** An accepted message moved the conversation to a new key; its input follows. */
  function moveThread(from: string, to: string) {
    flushDrafts();
    const moving = storedQueue(from) ?? queuesRef.current[from] ?? [];
    if (moving.length) {
      mutateQueue(from, () => []);
      mutateQueue(to, (list) => [
        ...moving,
        ...list.filter((item) => !moving.some((entry) => entry.id === item.id)),
      ]);
    }
    const movedDraft = draftRef.current[from] ?? storedDraft(from);
    if (movedDraft && !(draftRef.current[to] ?? storedDraft(to)))
      updateDraft(movedDraft, to);
    updateDraft("", from);
    flushDrafts();
    setAwaitingExecution((value) => {
      const { [from]: _migrated, ...rest } = value;
      return rest;
    });
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
  // Another tab changed a stored queue (enqueued, sent or removed a message).
  useEffect(() => {
    if (!storageKeyPrefix) return;
    const prefix = `${storageKeyPrefix}:`;
    const onStorage = (event: StorageEvent) => {
      if (event.key === null) {
        Object.keys(queuesRef.current).forEach(syncQueue);
      } else if (event.key.startsWith(prefix)) {
        const key = event.key.slice(prefix.length);
        if (key in queuesRef.current) syncQueue(key);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKeyPrefix]);
  useEffect(() => {
    if (!(threadKey in queuesRef.current)) syncQueue(threadKey);
    if (!(threadKey in draftRef.current)) {
      const restored = storedDraft(threadKey);
      if (restored) {
        draftRef.current = { ...draftRef.current, [threadKey]: restored };
        setDrafts(draftRef.current);
      }
    }
  }, [threadKey, storageKeyPrefix]);
  // One tab drains a stored queue; the others show it and take over on leaving.
  useEffect(() => {
    if (!storageKey) {
      setDispatcher(true);
      return;
    }
    setDispatcher(false);
    return holdDispatchLock(storageKey, () => setDispatcher(true));
  }, [storageKey]);
  useEffect(() => {
    if (previousReset.current !== draftResetKey) updateDraft("");
    previousReset.current = draftResetKey;
  }, [draftResetKey]);
  // An accepted send must not drain the next queued message until the host
  // has projected the execution it started (HTTP acknowledgement can beat SSE).
  useEffect(() => {
    if (!(threadKey in awaitingExecution)) return;
    if (
      props.active ||
      props.sending ||
      props.activeExecutionId !== awaitingExecution[threadKey]
    ) {
      setAwaitingExecution((value) => {
        const { [threadKey]: _done, ...rest } = value;
        return rest;
      });
    }
  }, [
    threadKey,
    props.active,
    props.sending,
    props.activeExecutionId,
    awaitingExecution,
  ]);

  function remove(id: string, key = threadKey) {
    mutateQueue(key, (list) => list.filter((item) => item.id !== id));
  }
  function move(id: string, direction: "before" | "after", targetId: string) {
    mutateQueue(threadKey, (list) => {
      const item = list.find((entry) => entry.id === id);
      if (!item || id === targetId) return list;
      const rest = list.filter((entry) => entry.id !== id);
      const target = rest.findIndex((entry) => entry.id === targetId);
      if (target < 0) return list;
      rest.splice(target + (direction === "after" ? 1 : 0), 0, item);
      return rest;
    });
  }
  function report(reason: unknown, key: string) {
    setErrors((value) => ({
      ...value,
      [key]: reason instanceof Error ? reason.message : String(reason),
    }));
    setPausedQueues((value) => ({ ...value, [key]: true }));
  }
  /**
   * Claims a queued message in storage so no other tab sends it too. False
   * when it must not be sent now: already sent, or another tab is sending it.
   * A claim whose tab closed mid-request may have reached the server, so it
   * waits for the person unless they asked to send it (`force`).
   */
  async function claim(item: QueuedDraft, key: string, force: boolean) {
    const stored = keyFor(key);
    if (!stored || unsaved.current.has(key)) return true;
    let claimed = claimQueuedDraft(stored, item.id, tab);
    if (claimed.result === "elsewhere") {
      if (await claimIsLive(claimed.item)) {
        syncQueue(key);
        return false;
      }
      if (!force) {
        syncQueue(key);
        report(new Error(i18n.t("conversation:errors.maybeSent")), key);
        return false;
      }
      claimed = claimQueuedDraft(stored, item.id, tab, true);
    }
    if (claimed.result === "gone") {
      syncQueue(key);
      return false;
    }
    if (claimed.result === "claimed") syncQueue(key);
    return true;
  }
  async function send(item?: QueuedDraft, { force = false } = {}) {
    const host = current.current;
    const text =
      item?.text ??
      draftRef.current[host.threadKey] ??
      storedDraft(host.threadKey);
    const immediate =
      !item && !host.attachments?.length && host.canSendDuringExecution?.(text);
    if (
      busy.current ||
      (host.active && !immediate) ||
      host.sending ||
      host.disabled ||
      host.readOnly ||
      host.attachmentUploading ||
      (host.threadKey in awaitingRef.current && !immediate)
    )
      return;
    const key = host.threadKey;
    if (
      !text.trim() &&
      !(item?.attachments?.length || host.attachments?.length)
    )
      return;
    busy.current = true;
    setPending(true);
    try {
      if (item && !(await claim(item, key, force))) return;
      setErrors((value) => ({ ...value, [key]: "" }));
      if (!item) updateDraft("", key);
      followLatest();
      try {
        const outcome = item
          ? await whileSending(item.id, () =>
              host.onSend(text, item.attachments, {
                idempotencyKey: item.id,
              }),
            )
          : await host.onSend(text);
        if (!outcome) throw new Error(i18n.t("conversation:errors.notSent"));
        if (item) remove(item.id, key);
        const movedTo =
          typeof outcome === "object" && outcome.threadKey !== key
            ? outcome.threadKey
            : undefined;
        if (movedTo) moveThread(key, movedTo);
        const latest = current.current;
        if (
          outcome !== "replied" &&
          latest.threadKey === key &&
          !latest.active &&
          !latest.sending &&
          latest.activeExecutionId === host.activeExecutionId
        )
          setAwaitingExecution((value) => ({
            ...value,
            [key]: host.activeExecutionId,
          }));
        setPausedQueues((value) => ({ ...value, [key]: false }));
      } catch (reason) {
        if (item)
          mutateQueue(key, (list) =>
            list.map((entry) =>
              entry.id === item.id ? withoutClaim(entry) : entry,
            ),
          );
        else if (!draftRef.current[key]) updateDraft(text, key);
        else
          mutateQueue(key, (list) => [
            { id: crypto.randomUUID(), text },
            ...list,
          ]);
        report(reason, key);
      }
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  function submit() {
    const host = current.current;
    if (host.disabled || host.readOnly || host.attachmentUploading) return;
    const text =
      draftRef.current[host.threadKey] ?? storedDraft(host.threadKey);
    if (!text.trim() && !host.attachments?.length) return;
    if (
      !host.attachments?.length &&
      host.canSendDuringExecution?.(text) &&
      !busy.current &&
      !host.sending
    ) {
      void send();
      return;
    }
    if (
      host.active ||
      host.sending ||
      busy.current ||
      queue.length ||
      host.threadKey in awaitingRef.current
    ) {
      const item: QueuedDraft = {
        id: crypto.randomUUID(),
        text: text.trim(),
        attachments: [...(host.attachments ?? [])],
        targetExecutionId: host.activeExecutionId,
      };
      mutateQueue(host.threadKey, (list) => [...list, item]);
      updateDraft("", host.threadKey);
      item.attachments?.forEach((attachment) =>
        host.onAttachmentRemove?.(attachment.id),
      );
    } else void send();
  }
  async function steer(item: QueuedDraft) {
    const host = current.current;
    if (!canSteer || busy.current || unavailable || !host.onSteer) return;
    if (
      item.targetExecutionId &&
      item.targetExecutionId !== host.activeExecutionId
    ) {
      report(
        new Error(i18n.t("conversation:errors.responseChanged")),
        host.threadKey,
      );
      return;
    }
    busy.current = true;
    setPending(true);
    setSteeringId(item.id);
    try {
      if (
        !(await host.onSteer(
          item.text,
          item.targetExecutionId ?? host.activeExecutionId,
        ))
      )
        throw new Error(i18n.t("conversation:errors.notSteered"));
      if (item.attachments?.length)
        host.onAttachmentsRestore?.(item.attachments);
      remove(item.id, host.threadKey);
      setErrors((value) => ({ ...value, [host.threadKey]: "" }));
      setPausedQueues((value) => ({ ...value, [host.threadKey]: false }));
    } catch (reason) {
      report(reason, host.threadKey);
    } finally {
      busy.current = false;
      setPending(false);
      setSteeringId(undefined);
    }
  }
  async function stop() {
    const host = current.current;
    if (busy.current || !host.onStop || !host.active) return;
    busy.current = true;
    setPending(true);
    try {
      await host.onStop(host.activeExecutionId);
    } catch (reason) {
      report(reason, host.threadKey);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  useEffect(() => {
    if (
      active ||
      unavailable ||
      !dispatcher ||
      !queue.length ||
      pausedQueues[threadKey]
    )
      return;
    const timer = window.setTimeout(() => void send(queue[0]), 180);
    return () => window.clearTimeout(timer);
  }, [
    active,
    unavailable,
    dispatcher,
    queue,
    pausedQueues,
    threadKey,
    props.onSend,
  ]);

  return {
    draft,
    queue,
    error: errors[threadKey],
    pending,
    active,
    canSteer,
    unavailable,
    steeringId,
    updateDraft,
    submit,
    /** The person chose to send this message now. */
    sendQueued: (item: QueuedDraft) => send(item, { force: true }),
    steer,
    stop,
    remove: (id: string) => remove(id),
    move,
    edit(item: QueuedDraft) {
      updateDraft(item.text);
      if (item.attachments?.length)
        props.onAttachmentsRestore?.(item.attachments);
      remove(item.id);
    },
  };
}
