import { ToastFeedback } from "../../components/ui/toast";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DeviceProjection } from "@bd777/foundry-protocol";
import { renameDevice } from "../../api";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
import { Dialog } from "../../components/ui/dialog";
import {
  WorkspaceField,
  WorkspaceForm,
  WorkspaceFormActions,
} from "../../components/workspace/workspace-form";

/** Renames a device for everyone who sees it; the hostname stays visible. */
export function DeviceRenameDialog({
  device,
  onClose,
  onSaved,
  returnFocusTo,
}: {
  device: DeviceProjection;
  onClose: () => void;
  onSaved: () => Promise<void>;
  returnFocusTo?: HTMLElement | null;
}) {
  const { t } = useTranslation(["devices", "common"]);
  const [value, setValue] = useState(device.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const field = useRef<HTMLInputElement>(null);
  async function submit() {
    if (busy || !value.trim()) return;
    setBusy(true);
    setError("");
    try {
      await renameDevice(device.id, value.trim());
      await onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("rename.failed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      initialFocus={field}
      returnFocusTo={returnFocusTo}
      title={t("rename.title")}
      description={t("rename.description", {
        hostname: device.system?.hostname ?? device.label,
      })}
      busy={busy}
      onClose={onClose}
    >
      <WorkspaceForm
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <WorkspaceField>
          {t("rename.label")}
          <TextInput
            ref={field}
            aria-label={t("rename.label")}
            tone="boxed"
            value={value}
            required
            maxLength={120}
            disabled={busy}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
        </WorkspaceField>
        {error ? <ToastFeedback tone="error" title={error} /> : null}
        <WorkspaceFormActions>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={busy || !value.trim()}
          >
            {busy ? t("common:actions.saving") : t("rename.submit")}
          </Button>
        </WorkspaceFormActions>
      </WorkspaceForm>
    </Dialog>
  );
}
