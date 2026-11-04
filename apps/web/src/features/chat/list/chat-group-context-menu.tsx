import {
  ContextMenuEntry,
  ContextMenuSurface,
} from "../../../components/ui/row-menu";
import { ToastFeedback } from "../../../components/ui/toast";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";

export function ChatGroupContextMenu({
  name,
  sessionCount,
  archiveCount = sessionCount,
  disabled,
  onRename,
  onDelete,
  onArchive,
  children,
}: {
  name: string;
  sessionCount: number;
  archiveCount?: number;
  disabled?: boolean;
  onRename: () => void;
  onDelete: () => Promise<void>;
  onArchive?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const movingFocus = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const busy = disabled || deleting;
  const remove = async () => {
    if (deleting || disabled) return;
    setDeleting(true);
    setError("");
    try {
      await onDelete();
      setOpen(false);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : t("groups.deleteFailed"),
      );
    } finally {
      setDeleting(false);
    }
  };
  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenuSurface
            collisionPadding={10}
            onCloseAutoFocus={(event) => {
              if (movingFocus.current) {
                event.preventDefault();
                movingFocus.current = false;
              }
            }}
          >
            <ContextMenuEntry
              disabled={busy}
              onSelect={() => {
                movingFocus.current = true;
                onRename();
              }}
            >
              {t("groups.rename")}
            </ContextMenuEntry>
            {onArchive ? (
              <ContextMenuEntry
                disabled={busy || !archiveCount}
                reason={
                  !archiveCount
                    ? t("archive.noChats")
                    : busy
                      ? t("archive.listUnavailable")
                      : undefined
                }
                onSelect={() => {
                  movingFocus.current = true;
                  onArchive();
                }}
              >
                {t("archive.folder", { count: archiveCount })}
              </ContextMenuEntry>
            ) : null}
            <ContextMenuEntry
              disabled={busy}
              onSelect={() => {
                if (sessionCount === 0) {
                  void remove();
                  return;
                }
                movingFocus.current = true;
                setError("");
                setOpen(true);
              }}
              tone="danger"
            >
              {t("groups.delete")}
            </ContextMenuEntry>
          </ContextMenuSurface>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {!open && error ? (
        <ToastFeedback
          tone="error"
          title={t("groups.deleteError", { error })}
        />
      ) : null}
      <Dialog
        title={t("groups.deleteTitle", { name })}
        description={t("groups.deleteDescription", { count: sessionCount })}
        open={open}
        onClose={() => setOpen(false)}
        busy={deleting}
        layout="compact"
        initialFocus={cancelRef}
        footer={
          <>
            <Button
              ref={cancelRef}
              variant="ghost"
              disabled={deleting}
              onClick={() => setOpen(false)}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button
              className="text-error-text"
              disabled={disabled || deleting}
              onClick={() => void remove()}
            >
              {deleting ? t("groups.deleting") : t("groups.deleteConfirm")}
            </Button>
          </>
        }
      >
        {error ? <ToastFeedback tone="error" title={error} /> : null}
      </Dialog>
    </>
  );
}
