import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast, ToastFeedback } from "../../components/ui/toast";
import type { ChatSurfaceProps } from "./chat-surface-types";

/** Feedback floats above either pane without changing the conversation layout. */
export function ChatArchiveFeedback({
  archiveToast,
  archiveError,
}: Pick<ChatSurfaceProps, "archiveToast" | "archiveError">) {
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
  return archiveError ? (
    <ToastFeedback tone="error" title={t("archive.failed")}>
      {archiveError}
    </ToastFeedback>
  ) : null;
}
