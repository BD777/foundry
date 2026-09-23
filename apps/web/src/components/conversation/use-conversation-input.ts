import { useEffect, useRef, useState } from "react";
import type { ConversationProps, QueuedDraft } from "./conversation-types";

function storedDraft(key?: string): string {
  try {
    return key ? (localStorage.getItem(key) ?? "") : "";
  } catch {
    return "";
  }
}

/** One input lifecycle for every conversation, independent of its transport. */
export function useConversationInput(
  props: ConversationProps,
  followLatest: () => void,
) {
  const { threadKey, draftStorageKey, draftResetKey } = props;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftRef = useRef(drafts);
  const [queues, setQueues] = useState<Record<string, QueuedDraft[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pausedQueues, setPausedQueues] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState(false);
  const [awaitingExecution, setAwaitingExecution] = useState<
    Record<string, string | undefined>
  >({});
  const awaitingRef = useRef(awaitingExecution);
  awaitingRef.current = awaitingExecution;
  const [steeringId, setSteeringId] = useState<string>();
  const busy = useRef(false);
  const current = useRef(props);
  current.current = props;
  const previousKey = useRef(threadKey);
  const previousReset = useRef(draftResetKey);
  const queue = queues[threadKey] ?? [];
  const draft = drafts[threadKey] ?? storedDraft(draftStorageKey);
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

  function updateDraft(value: string, key = threadKey) {
    draftRef.current = { ...draftRef.current, [key]: value };
    setDrafts(draftRef.current);
  }
  useEffect(() => {
    const old = previousKey.current;
    if (
      old !== threadKey &&
      old.endsWith(":new") &&
      !threadKey.endsWith(":new")
    ) {
      if (draftRef.current[old] && !draftRef.current[threadKey])
        updateDraft(draftRef.current[old], threadKey);
      setQueues((value) => {
        if (!value[old]?.length || value[threadKey]?.length) return value;
        const { [old]: moved, ...rest } = value;
        return { ...rest, [threadKey]: moved! };
      });
      updateDraft("", old);
      setAwaitingExecution((value) => {
        const { [old]: _migrated, ...rest } = value;
        return rest;
      });
    }
    previousKey.current = threadKey;
  }, [threadKey]);
  useEffect(() => {
    if (previousReset.current !== draftResetKey) updateDraft("");
    previousReset.current = draftResetKey;
  }, [draftResetKey]);
  useEffect(() => {
    if (!draftStorageKey) return;
    try {
      if (draft) localStorage.setItem(draftStorageKey, draft);
      else localStorage.removeItem(draftStorageKey);
    } catch {
      /* Storage may be unavailable. */
    }
  }, [draftStorageKey, draft]);
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

  function remove(id: string) {
    setQueues((value) =>
      Object.fromEntries(
        Object.entries(value).map(([key, list]) => [
          key,
          list.filter((item) => item.id !== id),
        ]),
      ),
    );
  }
  function move(id: string, direction: "before" | "after", targetId: string) {
    setQueues((value) => {
      const list = value[threadKey] ?? [];
      const item = list.find((entry) => entry.id === id);
      if (!item || id === targetId) return value;
      const rest = list.filter((entry) => entry.id !== id);
      const target = rest.findIndex((entry) => entry.id === targetId);
      if (target < 0) return value;
      rest.splice(target + (direction === "after" ? 1 : 0), 0, item);
      return { ...value, [threadKey]: rest };
    });
  }
  function report(reason: unknown, key: string) {
    setErrors((value) => ({
      ...value,
      [key]: reason instanceof Error ? reason.message : String(reason),
    }));
    setPausedQueues((value) => ({ ...value, [key]: true }));
  }
  async function send(item?: QueuedDraft) {
    const host = current.current;
    const text =
      item?.text ??
      draftRef.current[host.threadKey] ??
      storedDraft(host.draftStorageKey);
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
    setErrors((value) => ({ ...value, [key]: "" }));
    if (!item) updateDraft("", key);
    followLatest();
    try {
      const outcome = await host.onSend(text, item?.attachments);
      if (!outcome)
        throw new Error("Message was not sent. Your draft has been retained.");
      if (item) remove(item.id);
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
      if (!item) {
        if (!draftRef.current[key]) updateDraft(text, key);
        else
          setQueues((value) => ({
            ...value,
            [key]: [{ id: crypto.randomUUID(), text }, ...(value[key] ?? [])],
          }));
      }
      report(reason, key);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  function submit() {
    const host = current.current;
    if (host.disabled || host.readOnly || host.attachmentUploading) return;
    const text =
      draftRef.current[host.threadKey] ?? storedDraft(host.draftStorageKey);
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
      setQueues((value) => ({
        ...value,
        [host.threadKey]: [...(value[host.threadKey] ?? []), item],
      }));
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
        new Error(
          "The active response changed. This message remains queued for the next turn.",
        ),
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
        throw new Error(
          "The message could not be steered. It remains in the queue.",
        );
      if (item.attachments?.length)
        host.onAttachmentsRestore?.(item.attachments);
      remove(item.id);
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
    if (active || unavailable || !queue.length || pausedQueues[threadKey])
      return;
    const timer = window.setTimeout(() => void send(queue[0]), 180);
    return () => window.clearTimeout(timer);
  }, [active, unavailable, queue, pausedQueues, threadKey, props.onSend]);

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
    sendQueued: send,
    steer,
    stop,
    remove,
    move,
    edit(item: QueuedDraft) {
      updateDraft(item.text);
      if (item.attachments?.length)
        props.onAttachmentsRestore?.(item.attachments);
      remove(item.id);
    },
  };
}
