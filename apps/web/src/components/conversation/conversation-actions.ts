import { i18n } from "../../i18n";
import type {
  ConversationDelivery,
  ConversationProps,
  ConversationSendOutcome,
  QueuedDraft,
} from "./conversation-types";
import { whileSending } from "./conversation-storage";
import type { ConversationDrafts } from "./use-conversation-drafts";
import type { LocalQueue } from "./use-local-queue";
import type {
  AwaitingExecution,
  BusyGate,
  ComposerFlight,
} from "./use-send-tracking";
import type { useServerQueue } from "./use-server-queue";

/** One render of a conversation's input: what its actions read and change. */
export interface ConversationInputContext {
  /** The host's props now, which may be newer than this render's. */
  latest: () => ConversationProps;
  threadKey: string;
  /** A server-kept queue (chats) replaces the browser's queue and dispatcher. */
  serverMode: boolean;
  queue: QueuedDraft[];
  canSteer: boolean;
  unavailable: boolean;
  drafts: ConversationDrafts;
  local: LocalQueue;
  server: ReturnType<typeof useServerQueue>;
  flight: ComposerFlight;
  awaiting: AwaitingExecution;
  busy: BusyGate;
  status: {
    /** Shows why something failed and pauses the conversation's queue. */
    report: (reason: unknown, key: string) => void;
    setError: (key: string, message: string) => void;
    resume: (key: string) => void;
  };
  followLatest: () => void;
}

function removeQueued(ctx: ConversationInputContext, id: string, key: string) {
  if (ctx.serverMode) ctx.server.removeLocal(id, key);
  else ctx.local.remove(id, key);
}

/** Puts the composer's message in the queue; the composer lets it go. */
function parkInQueue(
  ctx: ConversationInputContext,
  host: ConversationProps,
  item: QueuedDraft,
) {
  const key = host.threadKey;
  if (ctx.serverMode) ctx.server.add(item, key);
  else ctx.local.append(key, item);
  ctx.drafts.update("", key);
  item.attachments?.forEach((attachment) =>
    host.onAttachmentRemove?.(attachment.id),
  );
}

/** An accepted message moved the conversation to a new key; its input follows. */
function moveThread(
  ctx: ConversationInputContext,
  from: string,
  to: string,
  { carryDraft = true } = {},
) {
  ctx.drafts.flush();
  ctx.server.moveThread(from, to);
  ctx.local.carry(from, to);
  if (carryDraft) {
    const movedDraft = ctx.drafts.read(from);
    if (movedDraft && !ctx.drafts.read(to)) ctx.drafts.update(movedDraft, to);
    ctx.drafts.update("", from);
  }
  ctx.drafts.flush();
  ctx.awaiting.clear(from);
}

function sendBlocked(
  ctx: ConversationInputContext,
  host: ConversationProps,
  immediate: boolean,
) {
  return (
    ctx.busy.held() ||
    (host.active && !immediate) ||
    host.sending ||
    host.disabled ||
    host.readOnly ||
    host.attachmentUploading ||
    (ctx.awaiting.isWaiting(host.threadKey) && !immediate)
  );
}

/** The server took the message: it leaves the queue or the composer. */
function settleAccepted(
  ctx: ConversationInputContext,
  host: ConversationProps,
  item: QueuedDraft | undefined,
  outcome: Exclude<ConversationSendOutcome, false | "queue">,
) {
  const key = host.threadKey;
  if (item) removeQueued(ctx, item.id, key);
  const movedTo =
    typeof outcome === "object" && outcome.threadKey !== key
      ? outcome.threadKey
      : undefined;
  if (!item && movedTo && ctx.latest().threadKey === key) {
    ctx.flight.handOff(key);
    moveThread(ctx, key, movedTo, { carryDraft: false });
  } else {
    // Accepted: the transcript shows it now, so the composer lets it go
    // (before a new chat's key moves, which would carry it along). Let go
    // earlier, the composer may hold new text by now.
    if (!item && !ctx.flight.released()) ctx.drafts.update("", key);
    if (movedTo) moveThread(ctx, key, movedTo);
  }
  const latest = ctx.latest();
  if (
    outcome !== "replied" &&
    latest.threadKey === key &&
    !latest.active &&
    !latest.sending &&
    latest.activeExecutionId === host.activeExecutionId
  )
    ctx.awaiting.set(key, host.activeExecutionId);
  ctx.status.resume(key);
}

/** The message did not go: it waits again where it was. */
function restoreUnsent(
  ctx: ConversationInputContext,
  item: QueuedDraft | undefined,
  text: string,
  key: string,
) {
  if (item) {
    if (!ctx.serverMode) ctx.local.unclaim(item.id, key);
  } else if (!ctx.flight.released() && !(ctx.drafts.typed(key) ?? "").trim())
    // Not shown anywhere else: the text returns to the composer.
    ctx.drafts.update(text, key);
}

/** Sends a queued message, or without one the composer's. */
export async function sendMessage(
  ctx: ConversationInputContext,
  item?: QueuedDraft,
  { force = false } = {},
) {
  const host = ctx.latest();
  const key = host.threadKey;
  const text = item?.text ?? ctx.drafts.read(key);
  const immediate = Boolean(
    !item && !host.attachments?.length && host.canSendDuringExecution?.(text),
  );
  if (sendBlocked(ctx, host, immediate)) return;
  if (!text.trim() && !(item?.attachments?.length || host.attachments?.length))
    return;
  ctx.busy.begin();
  const clientId = item ? item.id : crypto.randomUUID();
  if (!item)
    ctx.flight.start(
      key,
      clientId,
      (host.attachments ?? []).map((attachment) => attachment.id),
    );
  try {
    if (item && !ctx.serverMode) {
      const claim = await ctx.local.claim(item, key, force);
      if (claim === "maybeSent")
        ctx.status.report(
          new Error(i18n.t("conversation:errors.maybeSent")),
          key,
        );
      if (claim !== "send") return;
    }
    ctx.status.setError(key, "");
    ctx.followLatest();
    try {
      const outcome = item
        ? await whileSending(item.id, () =>
            host.onSend(text, item.attachments, { idempotencyKey: item.id }),
          )
        : await host.onSend(text, undefined, { idempotencyKey: clientId });
      if (!outcome) throw new Error(i18n.t("conversation:errors.notSent"));
      if (outcome === "queue") {
        // A turn started meanwhile; the message waits for it to end.
        if (!item)
          parkInQueue(ctx, host, {
            id: crypto.randomUUID(),
            text: text.trim(),
            attachments: [...(host.attachments ?? [])],
          });
        ctx.status.resume(key);
        return;
      }
      settleAccepted(ctx, host, item, outcome);
    } catch (reason) {
      restoreUnsent(ctx, item, text, key);
      ctx.status.report(reason, key);
    }
  } finally {
    ctx.busy.end();
    if (!item) ctx.flight.finish(key);
  }
}

/** Queues the composer's message on the server; it leaves once accepted. */
async function enqueueDraft(
  ctx: ConversationInputContext,
  item: QueuedDraft,
  host: ConversationProps,
) {
  const key = host.threadKey;
  ctx.flight.mark(key);
  ctx.status.setError(key, "");
  try {
    const refused = await ctx.server.enqueueNow(item);
    if (refused) {
      ctx.status.setError(key, refused);
      return;
    }
    ctx.drafts.update("", key);
    item.attachments?.forEach((attachment) =>
      host.onAttachmentRemove?.(attachment.id),
    );
  } finally {
    ctx.flight.mark(undefined);
  }
}

/**
 * The composer's send: now, or queued behind what runs or waits. During a
 * running turn of a server-kept chat, delivery is when the message enters
 * it (DEV-082): at its next step unless the person chose otherwise.
 */
export function submitDraft(
  ctx: ConversationInputContext,
  delivery?: ConversationDelivery,
) {
  const host = ctx.latest();
  const key = host.threadKey;
  if (host.disabled || host.readOnly || host.attachmentUploading) return;
  if (ctx.flight.sendingKey() === key) return;
  const text = ctx.drafts.read(key);
  if (!text.trim() && !host.attachments?.length) return;
  if (
    !host.attachments?.length &&
    host.canSendDuringExecution?.(text) &&
    !ctx.busy.held() &&
    !host.sending
  ) {
    void sendMessage(ctx);
    return;
  }
  if (
    !host.active &&
    !host.sending &&
    !ctx.busy.held() &&
    !ctx.queue.length &&
    !ctx.awaiting.isWaiting(key)
  ) {
    void sendMessage(ctx);
    return;
  }
  const chosen = delivery ?? "boundary";
  const item: QueuedDraft = {
    id: crypto.randomUUID(),
    text: text.trim(),
    attachments: [...(host.attachments ?? [])],
    targetExecutionId: host.activeExecutionId,
    ...(ctx.serverMode && ctx.canSteer && chosen !== "turn_end"
      ? { delivery: chosen }
      : {}),
  };
  if (ctx.serverMode && ctx.server.canEnqueueNow(key))
    void enqueueDraft(ctx, item, host);
  else parkInQueue(ctx, host, item);
}

/** Injects a queued message into the running execution. */
export async function steerQueued(
  ctx: ConversationInputContext,
  item: QueuedDraft,
) {
  const host = ctx.latest();
  if (!ctx.canSteer || ctx.busy.held() || ctx.unavailable || !host.onSteer)
    return;
  if (ctx.serverMode && !ctx.server.isLocal(item)) {
    ctx.busy.begin(item.id);
    try {
      await ctx.server.steer(item);
    } finally {
      ctx.busy.end();
    }
    return;
  }
  if (
    item.targetExecutionId &&
    item.targetExecutionId !== host.activeExecutionId
  ) {
    ctx.status.report(
      new Error(i18n.t("conversation:errors.responseChanged")),
      host.threadKey,
    );
    return;
  }
  ctx.busy.begin(item.id);
  try {
    if (
      !(await host.onSteer(
        item.text,
        item.targetExecutionId ?? host.activeExecutionId,
        item.attachments,
      ))
    )
      throw new Error(i18n.t("conversation:errors.notSteered"));
    removeQueued(ctx, item.id, host.threadKey);
    ctx.status.setError(host.threadKey, "");
    ctx.status.resume(host.threadKey);
  } catch (reason) {
    ctx.status.report(reason, host.threadKey);
  } finally {
    ctx.busy.end();
  }
}

/**
 * Sends the person's answer to the Agent's question: into the running turn
 * when one runs, else as the next turn's input. `key` names the card, so a
 * repeated request sends it once. Why it failed, if it did.
 */
export async function answerQuestion(
  ctx: ConversationInputContext,
  text: string,
  key: string,
): Promise<string | undefined> {
  const host = ctx.latest();
  if (ctx.unavailable) return i18n.t("conversation:errors.notSent");
  try {
    if (ctx.serverMode) return await ctx.server.answer(key, text);
    if (host.active && ctx.canSteer && host.onSteer) {
      return (await host.onSteer(text, host.activeExecutionId))
        ? undefined
        : i18n.t("conversation:errors.notSteered");
    }
    const outcome = await host.onSend(text, undefined, {
      idempotencyKey: key,
    });
    return outcome ? undefined : i18n.t("conversation:errors.notSent");
  } catch (reason) {
    return reason instanceof Error ? reason.message : String(reason);
  }
}

export async function stopTurn(ctx: ConversationInputContext) {
  const host = ctx.latest();
  if (ctx.busy.held() || !host.onStop || !host.active) return;
  ctx.busy.begin();
  try {
    await host.onStop(host.activeExecutionId);
  } catch (reason) {
    ctx.status.report(reason, host.threadKey);
  } finally {
    ctx.busy.end();
  }
}

/** What the queue's rows can do with their messages. */
export function queueControls(ctx: ConversationInputContext) {
  const { server, serverMode, threadKey } = ctx;
  return {
    remove(item: QueuedDraft) {
      if (serverMode) void server.remove(item);
      else ctx.local.remove(item.id, threadKey);
    },
    move(id: string, direction: "before" | "after", targetId: string) {
      if (serverMode) server.move(id, direction, targetId);
      else ctx.local.move(threadKey, id, direction, targetId);
    },
    /** A drag ended. */
    commitOrder: () => void server.commitOrder(),
    /** Moves a message one place up (-1) or down (1), e.g. from the keyboard. */
    shift(item: QueuedDraft, offset: -1 | 1) {
      if (serverMode) return void server.shift(item, offset);
      const index = ctx.queue.findIndex((entry) => entry.id === item.id);
      const target = ctx.queue[index + offset];
      if (index < 0 || !target || target.state === "dispatching") return;
      ctx.local.move(
        threadKey,
        item.id,
        offset < 0 ? "before" : "after",
        target.id,
      );
    },
    /** Server-kept messages are edited where they wait. */
    inlineEdit: serverMode,
    /** Text changes made where the message waits; false when refused. */
    saveEdit: (item: QueuedDraft, text: string) => server.edit(item, text),
    /** Moves a queued message back into the composer. */
    edit(item: QueuedDraft) {
      if (ctx.flight.sendingKey() === threadKey) return;
      ctx.drafts.update(item.text);
      if (item.attachments?.length)
        ctx.latest().onAttachmentsRestore?.(item.attachments);
      removeQueued(ctx, item.id, threadKey);
    },
    retry: (item: QueuedDraft) => void server.retry(item),
    /** When a waiting message enters the running turn (DEV-082). */
    setDelivery: (item: QueuedDraft, delivery: ConversationDelivery) =>
      void server.setDelivery(item, delivery),
    isLocal: server.isLocal,
  };
}
