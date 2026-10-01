import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CornerDownRight,
  FileText,
  GripVertical,
  Pencil,
  Trash2,
} from "lucide-react";
import { Button } from "../ui/button";
import { localImageUrl } from "../../api";
import type { useConversationInput } from "./use-conversation-input";

export function ConversationQueue({
  input,
  focus,
}: {
  input: ReturnType<typeof useConversationInput>;
  focus: () => void;
}) {
  const { t } = useTranslation("conversation");
  const [dragged, setDragged] = useState<string>();
  if (!input.queue.length) return null;
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
          <span className="fdy-chat-queue-text">{item.text}</span>
          {item.attachments?.length ? (
            <div className="fdy-chat-queue-attachments">
              {item.attachments.map((attachment) => (
                <span
                  className="fdy-chat-queue-attachment"
                  data-kind={attachment.kind}
                  key={attachment.id}
                  title={attachment.name}
                >
                  {attachment.kind === "image" ? (
                    <img
                      alt={attachment.name}
                      src={localImageUrl(attachment.path)}
                    />
                  ) : (
                    <FileText size={13} />
                  )}
                </span>
              ))}
            </div>
          ) : null}
          <div className="fdy-chat-queue-actions">
            <Button
              aria-label={
                input.canSteer
                  ? t("queue.steerHint")
                  : input.active
                    ? t("queue.queuedHint")
                    : t("queue.sendHint")
              }
              disabled={
                input.unavailable ||
                input.pending ||
                (input.active && !input.canSteer)
              }
              onClick={() => {
                if (input.canSteer) void input.steer(item);
                else void input.sendQueued(item);
              }}
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
            <Button
              aria-label={t("queue.edit")}
              disabled={input.pending}
              onClick={() => {
                input.edit(item);
                focus();
              }}
              variant="ghost"
            >
              <Pencil size={15} />
            </Button>
            <Button
              aria-label={t("queue.remove")}
              disabled={input.pending}
              onClick={() => input.remove(item.id)}
              variant="ghost"
            >
              <Trash2 size={15} />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
