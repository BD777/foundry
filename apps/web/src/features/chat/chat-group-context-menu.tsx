import {
  ContextMenuEntry,
  ContextMenuSurface,
} from "../../components/ui/row-menu";
import { ToastFeedback } from "../../components/ui/toast";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";

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
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          if (!deleting) setOpen(next);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fdy-chat-rename-overlay" />
          <Dialog.Content
            className="fdy-chat-rename-dialog fdy-chat-group-delete-dialog"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              cancelRef.current?.focus();
            }}
          >
            <Dialog.Title className="fdy-chat-group-delete-title">
              {t("groups.deleteTitle", { name })}
            </Dialog.Title>
            <Dialog.Description className="fdy-chat-group-delete-description">
              {t("groups.deleteDescription", { count: sessionCount })}
            </Dialog.Description>
            {error ? <ToastFeedback tone="error" title={error} /> : null}
            <div className="fdy-chat-rename-actions">
              <Dialog.Close asChild>
                <Button ref={cancelRef} variant="ghost" disabled={deleting}>
                  {t("common:actions.cancel")}
                </Button>
              </Dialog.Close>
              <Button
                className="fdy-chat-archive-destructive"
                disabled={disabled || deleting}
                onClick={() => void remove()}
              >
                {deleting ? t("groups.deleting") : t("groups.deleteConfirm")}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
