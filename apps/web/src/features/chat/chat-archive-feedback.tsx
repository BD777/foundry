import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "../../components/ui/toast";
import type { ChatSurfaceProps } from "./chat-surface-types";

/**
 * Feedback floats above either pane without changing the conversation
 * layout. A failed archive action toasts where it fails (useChatArchive);
 * a failed background read of the archive is no action's outcome: the app
 * status says when the server cannot be reached.
 */
export function ChatArchiveFeedback({
  archiveToast,
}: Pick<ChatSurfaceProps, "archiveToast">) {
  const { t } = useTranslation("chat");
  const toastId = useRef<string | undefined>(undefined);
  const latest = useRef(archiveToast);
  latest.current = archiveToast;
  const present = Boolean(archiveToast);
  const batchId = archiveToast?.id ?? archiveToast?.count;
  useEffect(() => {
    if (!present) return;
    const id = toast({
      tone: "success",
      title: t("archive.toast", { count: latest.current?.count }),
      action: {
        label: t("archive.undo"),
        onClick: () => latest.current?.onUndo(),
      },
    });
    toastId.current = id;
    return () => toast.dismiss(id);
  }, [present, batchId, t]);
  useEffect(() => {
    if (toastId.current && archiveToast)
      toast.update(toastId.current, {
        action: {
          label: t("archive.undo"),
          disabled: archiveToast.busy,
          onClick: () => latest.current?.onUndo(),
        },
      });
  }, [archiveToast?.busy, t]);
  return null;
}
