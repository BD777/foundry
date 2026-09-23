import { useRef, useState } from "react";
import type { DeviceProjection, WorkspaceProjection } from "@foundry/protocol";
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
  const title =
    edit.kind === "add"
      ? "Add workspace"
      : removing
        ? "Remove workspace"
        : "Rename workspace";
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
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save. Please try again.",
      );
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
      description={
        edit.kind === "add"
          ? `Register an existing folder on ${device.label}. Foundry adds its setup files and working folders; existing project files are preserved. Your current workspace does not change.`
          : removing
            ? "Remove this registration and its Foundry history. This cannot be undone."
            : "Change the display name in Foundry only. The folder, repository and workspace identity stay unchanged."
      }
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
          <p className="fdy-location-description">
            Initial setup may also initialize Git in a folder without a
            repository. Check the device and path before registering.
          </p>
        ) : null}
        {removing ? (
          <>
            <strong>{edit.workspace.name}</strong>
            <code className="fdy-workspace-path">
              {edit.workspace.localPath}
            </code>
            <p className="fdy-location-description">
              Chats, issues and run history in this workspace will be deleted
              from Foundry. Local files will not be deleted.
            </p>
            {blocked ? (
              <p role="status">
                This is your current workspace. Switch to another workspace
                before removing it.
              </p>
            ) : null}
          </>
        ) : (
          <label className="fdy-workspace-field">
            {edit.kind === "add" ? `Folder on ${device.label}` : "Display name"}
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
                aria-label="Workspace display name"
                tone="boxed"
                value={value}
                required
                maxLength={120}
                placeholder="Workspace name"
                disabled={busy}
                onChange={(event) => setValue(event.currentTarget.value)}
              />
            )}
          </label>
        )}
        {offline && edit.kind !== "rename" ? (
          <p role="status">
            Reconnect this device to{" "}
            {removing ? "remove its registration" : "register a folder"}.
          </p>
        ) : null}
        {error ? (
          <p className="fdy-location-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="fdy-workspace-form-actions">
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
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
              ? "Saving…"
              : removing
                ? "Remove workspace and history"
                : edit.kind === "add"
                  ? "Register folder"
                  : "Save display name"}
          </Button>
        </footer>
      </form>
    </WorkspaceDialog>
  );
}
