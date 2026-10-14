import { useEffect, useRef, useState } from "react";
import type { ConversationProps, QueuedDraft } from "./conversation-types";
import { conversationStorageKey } from "./conversation-storage";
import {
  queueControls,
  sendMessage,
  steerQueued,
  stopTurn,
  submitDraft,
  type ConversationInputContext,
} from "./conversation-actions";
import { useConversationDrafts } from "./use-conversation-drafts";
import { useLocalQueue } from "./use-local-queue";
import {
  useAwaitingExecution,
  useBusyGate,
  useComposerFlight,
} from "./use-send-tracking";
import { useServerQueue } from "./use-server-queue";

/** One input lifecycle for every conversation, independent of its transport. */
export function useConversationInput(
  props: ConversationProps,
  followLatest: () => void,
) {
  const { threadKey, storageKeyPrefix } = props;
  // A server-kept queue (chats) replaces the browser's queue and dispatcher.
  const serverMode = Boolean(props.serverQueue);
  const current = useRef(props);
  current.current = props;
  const latest = () => current.current;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pausedQueues, setPausedQueues] = useState<Record<string, boolean>>({});
  const busy = useBusyGate();
  const status: ConversationInputContext["status"] = {
    report(reason, key) {
      setErrors((value) => ({
        ...value,
        [key]: reason instanceof Error ? reason.message : String(reason),
      }));
      setPausedQueues((value) => ({ ...value, [key]: true }));
    },
    setError: (key, message) =>
      setErrors((value) => ({ ...value, [key]: message })),
    resume: (key) => setPausedQueues((value) => ({ ...value, [key]: false })),
  };
  const server = useServerQueue({
    server: props.serverQueue,
    threadKey,
    storageKey: conversationStorageKey(storageKeyPrefix, threadKey),
    holding: busy.pending || Boolean(props.sending),
    paused: Boolean(pausedQueues[threadKey]),
    onFailure: (message, key) => status.report(new Error(message), key),
    onKeepText: (text) => {
      if (!(drafts.typed(threadKey) ?? "").trim()) drafts.update(text);
    },
  });
  const drafts = useConversationDrafts(props);
  const local = useLocalQueue({ storageKeyPrefix, threadKey, serverMode });
  const flight = useComposerFlight({
    threadKey,
    messages: props.messages,
    drafts,
    latest,
  });
  const awaiting = useAwaitingExecution(props);
  const queue = serverMode ? server.items : local.items;
  const runtime =
    props.composer.mode === "fixed"
      ? props.composer.runtime
      : props.composer.mode === "selectable"
        ? props.composer.runtimeControls.selectedRuntime
        : undefined;
  const active = Boolean(
    props.active || props.sending || busy.pending || awaiting.waiting,
  );
  const canSteer = Boolean(
    props.active && runtime === "claude" && props.onSteer,
  );
  const unavailable = Boolean(
    props.disabled || props.readOnly || props.attachmentUploading,
  );
  const ctx: ConversationInputContext = {
    latest,
    threadKey,
    serverMode,
    queue,
    canSteer,
    unavailable,
    drafts,
    local,
    server,
    flight,
    awaiting,
    busy,
    status,
    followLatest,
  };

  // This tab drains a browser-kept queue once nothing runs or waits.
  useEffect(() => {
    if (
      serverMode ||
      active ||
      unavailable ||
      !local.dispatcher ||
      !queue.length ||
      pausedQueues[threadKey]
    )
      return;
    const timer = window.setTimeout(() => void sendMessage(ctx, queue[0]), 180);
    return () => window.clearTimeout(timer);
  }, [
    active,
    unavailable,
    local.dispatcher,
    queue,
    pausedQueues,
    threadKey,
    props.onSend,
    serverMode,
  ]);

  const hasContent = Boolean(drafts.draft.trim() || props.attachments?.length);
  return {
    draft: drafts.draft,
    queue,
    error: errors[threadKey],
    pending: busy.pending,
    active,
    /** This conversation's composer text is being sent: shown, not editable. */
    sending: flight.sending,
    /**
     * The primary button: Stop only for a running agent and an empty
     * composer; text typed meanwhile is sent (queued or steered) instead.
     */
    action: (flight.sending
      ? "sending"
      : props.active && !hasContent
        ? "stop"
        : "send") as "send" | "stop" | "sending",
    canSteer,
    unavailable,
    steeringId: busy.steeringId,
    updateDraft(value: string) {
      if (flight.sendingKey() !== threadKey) drafts.update(value);
    },
    submit: () => submitDraft(ctx),
    /** The person chose to send this message now. */
    sendQueued: (item: QueuedDraft) => sendMessage(ctx, item, { force: true }),
    steer: (item: QueuedDraft) => steerQueued(ctx, item),
    stop: () => stopTurn(ctx),
    ...queueControls(ctx),
    serverMode,
    /** How the last change to a server-kept queue went, when it was refused. */
    queueNotice: server.notice,
  };
}
