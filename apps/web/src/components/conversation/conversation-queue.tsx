import { FieldHint } from "../ui/field";
import { Alert } from "../ui/alert";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ChevronDown,
  CornerDownRight,
  GripVertical,
  Pencil,
  RotateCcw,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/field";
import { Tooltip } from "../ui/tooltip";
import { ChoiceMenu } from "../ui/choice-menu";
import { AttachmentList } from "./attachment-list";
import type {
  ConversationDelivery,
  ParsedImageTag,
  QueuedDraft,
} from "./conversation-types";
import { countdown, deliveryOptions } from "./delivery-choices";
import type { useConversationInput } from "./use-conversation-input";

type ConversationInput = ReturnType<typeof useConversationInput>;

interface QueueAction {
  label: string;
  hint: string;
  icon?: LucideIcon;
  run?: () => void;
}

/** The main action of a message: what sending it now means. */
function queueAction(
  item: QueuedDraft,
  input: ConversationInput,
  t: TFunction<"conversation">,
): QueueAction {
  const sendHint = input.canSteer
    ? t("queue.steerHint")
    : input.active
      ? t("queue.queuedHint")
      : t("queue.sendHint");
  const onServer = input.serverMode && !input.isLocal(item);
  if (item.state === "dispatching")
    return { label: t("queue.sending"), hint: t("queue.sendingHint") };
  if (item.state === "failed")
    return {
      label: t("queue.retry"),
      hint: t("queue.retryHint"),
      icon: RotateCcw,
      run: () => input.retry(item),
    };
  // A message the server could not send holds the ones after it.
  const held =
    onServer &&
    input.queue
      .slice(0, input.queue.indexOf(item))
      .some((entry) => entry.state === "failed");
  if (held) return { label: t("queue.waiting"), hint: t("queue.waitingHint") };
  if (input.canSteer)
    return {
      label:
        input.steeringId === item.id ? t("queue.steering") : t("queue.steer"),
      hint: sendHint,
      run: () => void input.steer(item),
    };
  if (input.active || onServer)
    // The server sends it when the running turn ends.
    return { label: t("queue.nextTurn"), hint: t("queue.queuedHint") };
  return {
    label: t("queue.send"),
    hint: sendHint,
    run: () => void input.sendQueued(item),
  };
}

/**
 * A message waiting for the running turn, whose delivery the person can
 * still change (DEV-082): kept on the server (or on its way there), not
 * being sent and not failed.
 */
function waitsForTurn(item: QueuedDraft, input: ConversationInput): boolean {
  return (
    input.deliveryChoices &&
    input.active &&
    (item.state === "queued" || item.state === "local")
  );
}

function deliveryOf(item: QueuedDraft): ConversationDelivery {
  return item.delivery ?? "turn_end";
}

/** The i18n key of a delivery's name. */
function deliveryKey(
  delivery: ConversationDelivery,
): "boundary" | "interrupt" | "turnEnd" {
  return delivery === "turn_end" ? "turnEnd" : delivery;
}

/** Now, every second while a countdown is shown. */
function useClock(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return now;
}

/**
 * Focus stays with the queue: a moved row's grip (its node may move), the
 * edit button once an edit ends, the next message's delete after a delete.
 */
function useQueueFocus() {
  const list = useRef<HTMLDivElement>(null);
  const pending = useRef<string | undefined>(undefined);
  useEffect(() => {
    const target = pending.current;
    if (!target) return;
    pending.current = undefined;
    for (const control of list.current?.querySelectorAll<HTMLElement>(
      "[data-queue-focus]",
    ) ?? [])
      if (control.dataset.queueFocus === target) control.focus();
  });
  return {
    list,
    refocus(target: string) {
      pending.current = target;
    },
  };
}

/** A server-kept message edited where it waits. */
function useQueueEditing(
  input: ConversationInput,
  refocus: (target: string) => void,
) {
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  const [saving, setSaving] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  // An edit starts with the caret after the text.
  useEffect(() => {
    const field = editor.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, [editing?.id]);
  function stop(item: QueuedDraft) {
    refocus(`edit:${item.id}`);
    setEditing(undefined);
  }
  return {
    editor,
    saving,
    /** The text being edited, when this message is. */
    textOf: (item: QueuedDraft) =>
      editing?.id === item.id ? editing.text : undefined,
    change: (item: QueuedDraft, text: string) =>
      setEditing({ id: item.id, text }),
    stop,
    async save(item: QueuedDraft) {
      if (!editing) return;
      setSaving(true);
      try {
        await input.saveEdit(item, editing.text);
        stop(item);
      } finally {
        setSaving(false);
      }
    },
  };
}

type QueueEditing = ReturnType<typeof useQueueEditing>;

export function ConversationQueue({
  input,
  focus,
  onPreview,
}: {
  input: ConversationInput;
  focus: () => void;
  onPreview: (image: ParsedImageTag) => void;
}) {
  const { t } = useTranslation("conversation");
  const [dragged, setDragged] = useState<string>();
  const { list, refocus } = useQueueFocus();
  const editing = useQueueEditing(input, refocus);
  // Codex rows count down to the moment a boundary message goes in anyway.
  const now = useClock(
    input.runtime === "codex" &&
      input.queue.some(
        (item) =>
          waitsForTurn(item, input) &&
          item.delivery === "boundary" &&
          item.fallbackAt,
      ),
  );
  if (!input.queue.length && !input.queueNotice) return null;
  function remove(item: QueuedDraft) {
    const index = input.queue.indexOf(item);
    const next = input.queue[index + 1] ?? input.queue[index - 1];
    input.remove(item);
    if (next) refocus(`remove:${next.id}`);
    else focus();
  }
  return (
    <div className="fdy-chat-queue" aria-label={t("queue.label")} ref={list}>
      {input.queueNotice ? (
        <Alert size="compact" tone="warning" title={input.queueNotice} />
      ) : null}
      {input.queue.map((item) => (
        <QueueItem
          dragged={dragged}
          editing={editing}
          input={input}
          item={item}
          key={item.id}
          now={now}
          onDragChange={setDragged}
          onEdit={() => {
            if (input.inlineEdit) editing.change(item, item.text);
            else {
              input.edit(item);
              focus();
            }
          }}
          onPreview={onPreview}
          onRemove={() => remove(item)}
          onShift={(offset) => {
            refocus(`grip:${item.id}`);
            input.shift(item, offset);
          }}
        />
      ))}
    </div>
  );
}

function QueueItem({
  item,
  input,
  dragged,
  editing,
  now,
  onDragChange,
  onEdit,
  onRemove,
  onShift,
  onPreview,
}: {
  item: QueuedDraft;
  input: ConversationInput;
  dragged: string | undefined;
  editing: QueueEditing;
  now: number;
  onDragChange: (id: string | undefined) => void;
  onEdit: () => void;
  onRemove: () => void;
  onShift: (offset: -1 | 1) => void;
  onPreview: (image: ParsedImageTag) => void;
}) {
  const { t } = useTranslation("conversation");
  const sending = item.state === "dispatching";
  const editText = editing.textOf(item);
  const draggable = !input.pending && !sending && editText === undefined;
  return (
    <div
      className="fdy-chat-queue-item"
      data-dragging={dragged === item.id ? "true" : "false"}
      data-editing={editText !== undefined ? "true" : "false"}
      data-maybe-sent={
        (item.state === "local" && item.sending) || item.maybeSent
          ? "true"
          : "false"
      }
      data-state={item.state ?? "queued"}
      data-delivery={waitsForTurn(item, input) ? deliveryOf(item) : undefined}
      draggable={draggable}
      onDragEnd={() => {
        onDragChange(undefined);
        input.commitOrder();
      }}
      onDragStart={(event) => {
        onDragChange(item.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(event) => {
        event.preventDefault();
        if (dragged && dragged !== item.id && !sending) {
          const bounds = event.currentTarget.getBoundingClientRect();
          input.move(
            dragged,
            event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
            item.id,
          );
        }
      }}
    >
      <Tooltip content={t("queue.reorderHint")}>
        <Button
          aria-keyshortcuts="ArrowUp ArrowDown"
          aria-label={t("queue.reorder")}
          className="fdy-chat-queue-grip"
          data-queue-focus={`grip:${item.id}`}
          disabled={!draggable || input.queue.length < 2}
          onKeyDown={(event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            onShift(event.key === "ArrowUp" ? -1 : 1);
          }}
          size="icon"
          variant="ghost"
        >
          <GripVertical size={15} />
        </Button>
      </Tooltip>
      <QueueItemBody
        delivery={
          waitsForTurn(item, input) && editText === undefined
            ? deliveryStatus(item, input, now, t)
            : undefined
        }
        editText={editText}
        editing={editing}
        item={item}
        onPreview={onPreview}
      />
      <div className="fdy-chat-queue-actions">
        {editText !== undefined ? (
          <QueueEditActions editing={editing} item={item} />
        ) : (
          <QueueItemActions
            input={input}
            item={item}
            onEdit={onEdit}
            onRemove={onRemove}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Where a message waiting for the running turn stands, beyond the mode its
 * switch names: what it waits for and, on Codex, when it goes in anyway.
 */
function deliveryStatus(
  item: QueuedDraft,
  input: ConversationInput,
  now: number,
  t: TFunction<"conversation">,
): string | undefined {
  const delivery = deliveryOf(item);
  if (delivery === "interrupt") return t("queue.deliveryInterrupt");
  if (delivery === "turn_end") return undefined;
  const left =
    input.runtime === "codex" && item.state === "queued"
      ? countdown(item.fallbackAt, now)
      : "";
  return left
    ? t("queue.deliveryBoundaryFallback", { time: left })
    : t("queue.deliveryBoundary");
}

function QueueItemBody({
  item,
  delivery,
  editText,
  editing,
  onPreview,
}: {
  item: QueuedDraft;
  /** Where it stands while it waits for the running turn. */
  delivery?: string;
  editText: string | undefined;
  editing: QueueEditing;
  onPreview: (image: ParsedImageTag) => void;
}) {
  const { t } = useTranslation("conversation");
  return (
    <div className="fdy-chat-queue-body">
      {editText !== undefined ? (
        <Textarea
          aria-label={t("queue.editLabel")}
          className="fdy-chat-queue-editor"
          onChange={(event) => editing.change(item, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") editing.stop(item);
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void editing.save(item);
            }
          }}
          ref={editing.editor}
          rows={2}
          tone="boxed"
          value={editText}
        />
      ) : item.text ? (
        <span className="fdy-chat-queue-text">{item.text}</span>
      ) : null}
      {item.attachments?.length ? (
        <AttachmentList attachments={item.attachments} onPreview={onPreview} />
      ) : null}
      {delivery ? (
        <span className="fdy-chat-queue-delivery">{delivery}</span>
      ) : null}
      {item.state === "local" && item.sending ? (
        <span className="fdy-chat-queue-warning">{t("queue.maybeSent")}</span>
      ) : null}
      {item.state === "failed" && item.error ? (
        <FieldHint
          as="span"
          tone="error"
          role="alert"
          className={
            item.maybeSent ? "fdy-chat-queue-warning" : "fdy-chat-queue-error"
          }
        >
          {item.maybeSent
            ? t("queue.unconfirmed", { error: item.error })
            : t("queue.failed", { error: item.error })}
        </FieldHint>
      ) : null}
    </div>
  );
}

function QueueEditActions({
  item,
  editing,
}: {
  item: QueuedDraft;
  editing: QueueEditing;
}) {
  const { t } = useTranslation("conversation");
  return (
    <>
      <Button
        className="fdy-chat-queue-action"
        disabled={editing.saving}
        onClick={() => void editing.save(item)}
        size="sm"
        variant="ghost"
      >
        {t("queue.save")}
      </Button>
      <Button
        className="fdy-chat-queue-action"
        disabled={editing.saving}
        onClick={() => editing.stop(item)}
        size="sm"
        variant="ghost"
      >
        {t("queue.cancel")}
      </Button>
    </>
  );
}

function QueueItemActions({
  item,
  input,
  onEdit,
  onRemove,
}: {
  item: QueuedDraft;
  input: ConversationInput;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("conversation");
  const main = queueAction(item, input, t);
  const Icon = main.icon ?? CornerDownRight;
  const sending = item.state === "dispatching";
  const delivery = deliveryOf(item);
  return (
    <>
      {waitsForTurn(item, input) ? (
        <ChoiceMenu
          disabled={input.unavailable}
          label={t("queue.deliveryChange", {
            mode: t(`delivery.${deliveryKey(delivery)}`),
          })}
          onChoose={(value) => input.setDelivery(item, value)}
          options={deliveryOptions(t, input.runtime, { shortcuts: false })}
          side="top"
          triggerClassName="fdy-chat-queue-action fdy-chat-queue-mode"
          triggerSize="sm"
          value={delivery}
        >
          <span>{t(`delivery.${deliveryKey(delivery)}`)}</span>
          <ChevronDown size={14} />
        </ChoiceMenu>
      ) : (
        <Tooltip content={main.hint}>
          <Button
            aria-label={main.hint}
            className="fdy-chat-queue-action"
            disabled={!main.run || input.unavailable || input.pending}
            onClick={main.run}
            size="sm"
            variant="ghost"
          >
            <Icon size={15} />
            <span>{main.label}</span>
          </Button>
        </Tooltip>
      )}
      <Tooltip content={t("queue.edit")}>
        <Button
          aria-label={t("queue.edit")}
          className="fdy-chat-queue-action"
          data-queue-focus={`edit:${item.id}`}
          disabled={input.pending || sending}
          onClick={onEdit}
          size="icon"
          variant="ghost"
        >
          <Pencil size={15} />
        </Button>
      </Tooltip>
      <Tooltip content={t("queue.remove")}>
        <Button
          aria-label={t("queue.remove")}
          className="fdy-chat-queue-action"
          data-queue-focus={`remove:${item.id}`}
          disabled={input.pending || sending}
          onClick={onRemove}
          size="icon"
          variant="ghost"
        >
          <Trash2 size={15} />
        </Button>
      </Tooltip>
    </>
  );
}
