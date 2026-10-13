import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";

/** A chat's rename: the dialog's draft, saving state and error. */
export function useChatRename(
  title: string,
  onRename: (title: string) => Promise<void>,
) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (saving || !draft.trim()) return;
    setSaving(true);
    setError("");
    try {
      await onRename(draft.trim());
      setOpen(false);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : t("listRow.renameFailed"),
      );
    } finally {
      setSaving(false);
    }
  };
  return {
    open,
    draft,
    saving,
    error,
    setDraft,
    save,
    /** Opens the dialog on the chat's current title. */
    begin() {
      setDraft(title);
      setError("");
      setOpen(true);
    },
    /** Closing is refused while the new name saves. */
    setOpen(next: boolean) {
      if (!saving) setOpen(next);
    },
  };
}

export type ChatRename = ReturnType<typeof useChatRename>;

export function ChatRenameDialog({ rename }: { rename: ChatRename }) {
  const { t } = useTranslation(["chat", "common"]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { draft, error, saving } = rename;
  return (
    <Dialog.Root open={rename.open} onOpenChange={rename.setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fdy-chat-rename-overlay" />
        <Dialog.Content
          className="fdy-chat-rename-dialog"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
            inputRef.current?.select();
          }}
        >
          <Dialog.Title className="fdy-chat-rename-title">
            {t("listRow.renameTitle")}
          </Dialog.Title>
          <TextInput
            aria-label={t("listRow.nameLabel")}
            className="fdy-chat-rename-input"
            maxLength={120}
            ref={inputRef}
            value={draft}
            disabled={saving}
            onChange={(event) => rename.setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void rename.save();
              }
            }}
          />
          {error ? (
            <p className="fdy-chat-rename-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="fdy-chat-rename-actions">
            <Dialog.Close asChild>
              <Button variant="ghost" disabled={saving}>
                {t("common:actions.cancel")}
              </Button>
            </Dialog.Close>
            <Button
              variant="primary"
              disabled={saving || !draft.trim()}
              onClick={() => void rename.save()}
            >
              {saving ? t("common:actions.saving") : t("common:actions.save")}
            </Button>
          </div>
          <Dialog.Close asChild>
            <Button
              aria-label={t("listRow.closeRename")}
              className="fdy-chat-rename-close"
              variant="ghost"
              size="icon"
              disabled={saving}
            >
              <X size={16} />
            </Button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
