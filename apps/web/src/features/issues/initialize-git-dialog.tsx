import { ToastFeedback } from "../../components/ui/toast";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { WorkspaceDialog } from "../../components/workspace/workspace-dialog";

/**
 * Asked before the first Issue in a folder without Git or commits: says
 * exactly what setting up Git does there. Cancel changes nothing.
 */
export function InitializeGitDialog({
  path,
  onConfirm,
  onCancel,
}: {
  path: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["issues", "common"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function confirm(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("gitSetup.failed"));
      setBusy(false);
    }
  }

  return (
    <WorkspaceDialog
      title={t("gitSetup.title")}
      description={t("gitSetup.description", { path })}
      busy={busy}
      onClose={onCancel}
    >
      <form
        aria-busy={busy}
        className="fdy-git-setup-form"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        {error ? <ToastFeedback tone="error" title={error} /> : null}
        <footer className="fdy-git-setup-actions">
          <Button variant="secondary" disabled={busy} onClick={onCancel}>
            {t("common:actions.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? t("gitSetup.confirming") : t("gitSetup.confirm")}
          </Button>
        </footer>
      </form>
    </WorkspaceDialog>
  );
}
