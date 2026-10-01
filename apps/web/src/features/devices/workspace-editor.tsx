import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceProjection,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { createWorkspace, deleteWorkspace, renameWorkspace } from "../../api";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
import { WorkspaceDialog } from "./workspace-dialog";
import { WorkspacePathPicker } from "./workspace-path-picker";

export type WorkspaceEdit =
  | { kind: "add" }
  | { kind: "rename" | "remove"; workspace: WorkspaceProjection };

export function WorkspaceEditor({
  edit,
  device,
  activeWorkspaceId,
  onClose,
  onSaved,
  returnFocusTo,
}: {
  edit: WorkspaceEdit;
  device: DeviceProjection;
  activeWorkspaceId: string;
  onClose: () => void;
  onSaved: (
    kind: WorkspaceEdit["kind"],
    workspace: WorkspaceProjection,
  ) => Promise<void>;
  returnFocusTo?: HTMLElement | null;
}) {
  const { t } = useTranslation(["workspaces", "common"]);
  const [value, setValue] = useState(
    edit.kind === "rename" ? edit.workspace.name : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const removing = edit.kind === "remove";
  const blocked = removing && edit.workspace.id === activeWorkspaceId;
  const offline = device.status !== "connected";
  const title = t(`editor.titles.${edit.kind}`);
  async function submit() {
    if (pending.current || blocked || (edit.kind !== "rename" && offline))
      return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const saved =
        edit.kind === "add"
          ? await createWorkspace({ deviceId: device.id, path: value.trim() })
          : edit.kind === "rename"
            ? await renameWorkspace(edit.workspace.id, value.trim())
            : await deleteWorkspace(edit.workspace.id);
      // The mutation has succeeded. Refresh errors must not invite resubmission.
      await onSaved(edit.kind, saved);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("editor.saveFailed"));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <WorkspaceDialog
      initialFocus={field}
      returnFocusTo={returnFocusTo}
      title={title}
      description={t(`editor.descriptions.${edit.kind}`, {
        device: device.label,
      })}
      busy={busy}
      onClose={onClose}
    >
      <form
        aria-busy={busy}
        className="fdy-workspace-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {edit.kind === "add" ? (
          <p className="fdy-location-description">{t("editor.addNote")}</p>
        ) : null}
        {removing ? (
          <>
            <strong>{edit.workspace.name}</strong>
            <code className="fdy-workspace-path">
              {edit.workspace.localPath}
            </code>
            <p className="fdy-location-description">{t("editor.removeNote")}</p>
            {blocked ? <p role="status">{t("editor.blocked")}</p> : null}
          </>
        ) : (
          <label className="fdy-workspace-field">
            {edit.kind === "add"
              ? t("editor.folderOn", { device: device.label })
              : t("editor.displayName")}
            {edit.kind === "add" ? (
              <WorkspacePathPicker
                deviceId={device.id}
                disabled={busy}
                inputRef={field}
                offline={offline}
                onChange={setValue}
                value={value}
              />
            ) : (
              <TextInput
                ref={field}
                aria-label={t("editor.displayNameLabel")}
                tone="boxed"
                value={value}
                required
                maxLength={120}
                placeholder={t("editor.namePlaceholder")}
                disabled={busy}
                onChange={(event) => setValue(event.currentTarget.value)}
              />
            )}
          </label>
        )}
        {offline && edit.kind !== "rename" ? (
          <p role="status">
            {removing ? t("editor.reconnectRemove") : t("editor.reconnectAdd")}
          </p>
        ) : null}
        {error ? (
          <p className="fdy-location-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="fdy-workspace-form-actions">
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            className={removing ? "fdy-workspace-danger" : undefined}
            disabled={
              busy ||
              blocked ||
              (offline && edit.kind !== "rename") ||
              (!removing && !value.trim())
            }
          >
            {busy
              ? t("common:actions.saving")
              : t(`editor.submit.${edit.kind}`)}
          </Button>
        </footer>
      </form>
    </WorkspaceDialog>
  );
}
