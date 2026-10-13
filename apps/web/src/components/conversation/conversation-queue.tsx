import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
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
import { AttachmentList } from "./attachment-list";
import type { ParsedImageTag, QueuedDraft } from "./conversation-types";
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
        <p className="fdy-chat-queue-notice" role="status">
          {input.queueNotice}
        </p>
      ) : null}
      {input.queue.map((item) => (
        <QueueItem
          dragged={dragged}
          editing={editing}
          input={input}
          item={item}
          key={item.id}
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

function QueueItemBody({
  item,
  editText,
  editing,
  onPreview,
}: {
  item: QueuedDraft;
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
      {item.state === "local" && item.sending ? (
        <span className="fdy-chat-queue-warning">{t("queue.maybeSent")}</span>
      ) : null}
      {item.state === "failed" && item.error ? (
        <span
          className={
            item.maybeSent ? "fdy-chat-queue-warning" : "fdy-chat-queue-error"
          }
          role="alert"
        >
          {item.maybeSent
            ? t("queue.unconfirmed", { error: item.error })
            : t("queue.failed", { error: item.error })}
        </span>
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
  return (
    <>
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
