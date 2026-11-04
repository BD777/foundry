import { ToastFeedback } from "../../../components/ui/toast";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { TextInput } from "../../../components/ui/field";

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
    <Dialog
      title={t("listRow.renameTitle")}
      open={rename.open}
      onClose={() => rename.setOpen(false)}
      busy={saving}
      layout="compact"
      initialFocus={inputRef}
      footer={
        <>
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => rename.setOpen(false)}
          >
            {t("common:actions.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={saving || !draft.trim()}
            onClick={() => void rename.save()}
          >
            {saving ? t("common:actions.saving") : t("common:actions.save")}
          </Button>
        </>
      }
    >
      <TextInput
        aria-label={t("listRow.nameLabel")}
        fieldSize="chat"
        tone="boxed"
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
      {error ? <ToastFeedback tone="error" title={error} /> : null}
    </Dialog>
  );
}
