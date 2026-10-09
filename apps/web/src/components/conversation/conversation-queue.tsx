import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CornerDownRight, GripVertical, Pencil, Trash2 } from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import { AttachmentList, type ParsedImageTag } from "./chat-message-content";
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
  if (!input.queue.length) return null;
  const sendHint = input.canSteer
    ? t("queue.steerHint")
    : input.active
      ? t("queue.queuedHint")
      : t("queue.sendHint");
  return (
    <div className="fdy-chat-queue" aria-label={t("queue.label")}>
      {input.queue.map((item) => (
        <div
          className="fdy-chat-queue-item"
          data-dragging={dragged === item.id ? "true" : "false"}
          draggable={!input.pending}
          key={item.id}
          onDragEnd={() => setDragged(undefined)}
          onDragStart={(event) => {
            setDragged(item.id);
            event.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(event) => {
            event.preventDefault();
            if (dragged && dragged !== item.id) {
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
          <span className="fdy-chat-queue-grip" aria-hidden="true">
            <GripVertical size={15} />
          </span>
          <div className="fdy-chat-queue-body">
            {item.text ? (
              <span className="fdy-chat-queue-text">{item.text}</span>
            ) : null}
            {item.attachments?.length ? (
              <AttachmentList
                attachments={item.attachments}
                onPreview={onPreview}
              />
            ) : null}
          </div>
          <div className="fdy-chat-queue-actions">
            <Tooltip content={sendHint}>
              <Button
                aria-label={sendHint}
                className="fdy-chat-queue-action"
                disabled={
                  input.unavailable ||
                  input.pending ||
                  (input.active && !input.canSteer)
                }
                onClick={() => {
                  if (input.canSteer) void input.steer(item);
                  else void input.sendQueued(item);
                }}
                size="sm"
                variant="ghost"
              >
                <CornerDownRight size={15} />
                <span>
                  {input.steeringId === item.id
                    ? t("queue.steering")
                    : input.canSteer
                      ? t("queue.steer")
                      : input.active
                        ? t("queue.nextTurn")
                        : t("queue.send")}
                </span>
              </Button>
            </Tooltip>
            <Tooltip content={t("queue.edit")}>
              <Button
                aria-label={t("queue.edit")}
                className="fdy-chat-queue-action"
                disabled={input.pending}
                onClick={() => {
                  input.edit(item);
                  focus();
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
                disabled={input.pending}
                onClick={() => input.remove(item.id)}
                size="icon"
                variant="ghost"
              >
                <Trash2 size={15} />
              </Button>
            </Tooltip>
          </div>
        </div>
      ))}
    </div>
  );
}
