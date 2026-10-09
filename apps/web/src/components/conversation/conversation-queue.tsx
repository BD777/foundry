import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CornerDownRight,
  GripVertical,
  Pencil,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/field";
import { Tooltip } from "../ui/tooltip";
import { AttachmentList, type ParsedImageTag } from "./chat-message-content";
import type { QueuedDraft } from "./conversation-types";
import type { useConversationInput } from "./use-conversation-input";

export function ConversationQueue({
  input,
  focus,
  onPreview,
}: {
  input: ReturnType<typeof useConversationInput>;
  focus: () => void;
  onPreview: (image: ParsedImageTag) => void;
}) {
  const { t } = useTranslation("conversation");
  const [dragged, setDragged] = useState<string>();
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  const [saving, setSaving] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  // Focus stays with the queue: a moved row's grip (its node may move), the
  // edit button once an edit ends, the next message's delete after a delete.
  const refocus = useRef<string | undefined>(undefined);
  useEffect(() => {
    const target = refocus.current;
    if (!target) return;
    refocus.current = undefined;
    for (const control of list.current?.querySelectorAll<HTMLElement>(
      "[data-queue-focus]",
    ) ?? [])
      if (control.dataset.queueFocus === target) control.focus();
  });
  // An edit starts with the caret after the text.
  useEffect(() => {
    const field = editor.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, [editing?.id]);
  if (!input.queue.length && !input.queueNotice) return null;
  const sendHint = input.canSteer
    ? t("queue.steerHint")
    : input.active
      ? t("queue.queuedHint")
      : t("queue.sendHint");
  function stopEditing(item: QueuedDraft) {
    refocus.current = `edit:${item.id}`;
    setEditing(undefined);
  }
  async function save(item: QueuedDraft) {
    if (!editing) return;
    setSaving(true);
    try {
      await input.saveEdit(item, editing.text);
      stopEditing(item);
    } finally {
      setSaving(false);
    }
  }
  /** The main action of a message: what sending it now means. */
  function action(item: QueuedDraft) {
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
    if (held)
      return { label: t("queue.waiting"), hint: t("queue.waitingHint") };
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
  return (
    <div className="fdy-chat-queue" aria-label={t("queue.label")} ref={list}>
      {input.queueNotice ? (
        <p className="fdy-chat-queue-notice" role="status">
          {input.queueNotice}
        </p>
      ) : null}
      {input.queue.map((item) => {
        const main = action(item);
        const Icon = main.icon ?? CornerDownRight;
        const sending = item.state === "dispatching";
        const draggable = !input.pending && !sending && editing?.id !== item.id;
        return (
          <div
            className="fdy-chat-queue-item"
            data-dragging={dragged === item.id ? "true" : "false"}
            data-editing={editing?.id === item.id ? "true" : "false"}
            data-maybe-sent={
              item.state === "local" && item.sending ? "true" : "false"
            }
            data-state={item.state ?? "queued"}
            draggable={draggable}
            key={item.id}
            onDragEnd={() => {
              setDragged(undefined);
              input.commitOrder();
            }}
            onDragStart={(event) => {
              setDragged(item.id);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => {
              event.preventDefault();
              if (dragged && dragged !== item.id && !sending) {
                const bounds = event.currentTarget.getBoundingClientRect();
                input.move(
                  dragged,
                  event.clientY < bounds.top + bounds.height / 2
                    ? "before"
                    : "after",
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
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown")
                    return;
                  event.preventDefault();
                  refocus.current = `grip:${item.id}`;
                  input.shift(item, event.key === "ArrowUp" ? -1 : 1);
                }}
                size="icon"
                variant="ghost"
              >
                <GripVertical size={15} />
              </Button>
            </Tooltip>
            <div className="fdy-chat-queue-body">
              {editing?.id === item.id ? (
                <Textarea
                  aria-label={t("queue.editLabel")}
                  className="fdy-chat-queue-editor"
                  onChange={(event) =>
                    setEditing({ id: item.id, text: event.target.value })
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Escape") stopEditing(item);
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void save(item);
                    }
                  }}
                  ref={editor}
                  rows={2}
                  tone="boxed"
                  value={editing.text}
                />
              ) : item.text ? (
                <span className="fdy-chat-queue-text">{item.text}</span>
              ) : null}
              {item.attachments?.length ? (
                <AttachmentList
                  attachments={item.attachments}
                  onPreview={onPreview}
                />
              ) : null}
              {item.state === "local" && item.sending ? (
                <span className="fdy-chat-queue-warning">
                  {t("queue.maybeSent")}
                </span>
              ) : null}
              {item.state === "failed" && item.error ? (
                <span className="fdy-chat-queue-error" role="alert">
                  {t("queue.failed", { error: item.error })}
                </span>
              ) : null}
            </div>
            <div className="fdy-chat-queue-actions">
              {editing?.id === item.id ? (
                <>
                  <Button
                    className="fdy-chat-queue-action"
                    disabled={saving}
                    onClick={() => void save(item)}
                    size="sm"
                    variant="ghost"
                  >
                    {t("queue.save")}
                  </Button>
                  <Button
                    className="fdy-chat-queue-action"
                    disabled={saving}
                    onClick={() => stopEditing(item)}
                    size="sm"
                    variant="ghost"
                  >
                    {t("queue.cancel")}
                  </Button>
                </>
              ) : (
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
                      onClick={() => {
                        if (input.inlineEdit)
                          setEditing({ id: item.id, text: item.text });
                        else {
                          input.edit(item);
                          focus();
                        }
                      }}
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
                      onClick={() => {
                        const index = input.queue.indexOf(item);
                        const next =
                          input.queue[index + 1] ?? input.queue[index - 1];
                        input.remove(item);
                        if (next) refocus.current = `remove:${next.id}`;
                        else focus();
                      }}
                      size="icon"
                      variant="ghost"
                    >
                      <Trash2 size={15} />
                    </Button>
                  </Tooltip>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
