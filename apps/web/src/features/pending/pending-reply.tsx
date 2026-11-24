import { useCallback, useEffect, useId, type Ref } from "react";
import { useTranslation } from "react-i18next";
import type { ChatAttachment } from "@bd777/foundry-protocol";
import type { PendingItem } from "../../api";
import { AttachmentComposer } from "../../components/conversation/attachment-composer";
import { useChatAttachments } from "../../components/conversation/use-chat-attachments";
import { useWorkspaceSlashItems } from "../../components/conversation/use-workspace-slash-items";
import { Button } from "../../components/ui/button";
import { FieldHint } from "../../components/ui/field";
import { toast, type ToastTone } from "../../components/ui/toast";
import { cn } from "../../lib/cn";
import { pendingReplyHintKey, pendingReplyRoute } from "./pending-model";

/**
 * The reply to one item, written in the chat's composer: Enter sends,
 * Shift+Enter adds a line, "/" offers the skills of the chat it goes to and
 * files are picked, pasted or dropped. Only a reply that becomes the chat's
 * message carries files and skills; an answer to an Issue, an assistant's
 * question or a waiting item is text.
 */
export function PendingReply({
  item,
  title,
  draft,
  onDraftChange,
  sending,
  compact,
  inputRef,
  onSend,
  onCancel,
}: {
  item: PendingItem;
  title: string;
  draft: string;
  onDraftChange: (value: string) => void;
  sending: boolean;
  compact: boolean;
  inputRef?: Ref<HTMLTextAreaElement>;
  /** Resolves true once the reply is on its way. */
  onSend: (text: string, attachments: ChatAttachment[]) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { t } = useTranslation("pending");
  const hintId = useId();
  const asMessage = pendingReplyRoute(item) === "chat";
  const notify = useCallback(async (message: string, tone?: ToastTone) => {
    toast(tone ? { title: message, tone } : { title: message });
  }, []);
  // Files land where the chat's own composer puts them: its workspace.
  const attachments = useChatAttachments({
    notify,
    workspaceId: item.workspaceId,
  });
  const { reset: resetAttachments } = attachments;
  useEffect(() => resetAttachments(), [item.id, resetAttachments]);
  const slashItems = useWorkspaceSlashItems({
    workspaceId: item.workspaceId,
    sessionId: item.sessionId,
    enabled: asMessage,
  });
  const canSend =
    Boolean(draft.trim()) && !sending && !(asMessage && attachments.uploading);
  const send = async () => {
    if (!canSend) return;
    const files = asMessage ? attachments.attachments : [];
    if (await onSend(draft, files)) attachments.removeSent(files);
  };
  return (
    <div className="mt-1 grid min-w-0 gap-1.5">
      <AttachmentComposer
        className={cn(
          "shadow-field focus-within:shadow-field-focus",
          compact ? "px-2 py-1.5" : "px-2.5 py-2",
        )}
        hideAgent
        input={{
          "aria-describedby": hintId,
          "aria-label": t("item.replyLabel", { title }),
          "aria-busy": sending,
          placeholder: t("item.replyPlaceholder"),
          readOnly: sending,
          ref: inputRef,
          value: draft,
          onChange: (event) => onDraftChange(event.target.value),
          onInput: (event) => onDraftChange(event.currentTarget.value),
          // An open "/" menu takes the first Escape; the next closes the reply.
          onEscape: () => {
            if (!sending) onCancel();
          },
          onSubmit: () => void send(),
          submitDisabled: !canSend,
        }}
        slashItems={asMessage ? slashItems : undefined}
        attachments={asMessage ? attachments.attachments : undefined}
        attachmentUploading={asMessage && attachments.uploading}
        onAttachmentsAdd={
          asMessage ? (files) => void attachments.add(files) : undefined
        }
        onAttachmentRemove={attachments.remove}
        locked={sending}
        controlsDisabled={sending}
        actionLabel={sending ? t("item.sending") : t("item.send")}
        actionState={sending ? "sending" : "send"}
        actionDisabled={!canSend}
        onAction={() => void send()}
      />
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <FieldHint id={hintId}>{t(pendingReplyHintKey(item))}</FieldHint>
        <Button
          className="ml-auto"
          disabled={sending}
          onClick={onCancel}
          size="sm"
          variant="ghost"
        >
          {t("item.cancel")}
        </Button>
      </div>
    </div>
  );
}
